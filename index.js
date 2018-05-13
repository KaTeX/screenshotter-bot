const url = require('url');
const got = require('got');

const BROWSERS = ['Firefox', 'Chrome'];
const CHECK_NAME = browser => `Screenshotter - ${browser}`;

module.exports = (robot) => {
    robot.log('The app is successfully loaded!');

    // https://developer.github.com/v3/activity/events/types/#checksuiteevent
    robot.on('check_suite.requested', async context => {
        robot.log('Received check_suite.requested');
        const payload = context.payload;
        const checkSuite = payload.check_suite;

        for (let i = 0; i < BROWSERS.length; i++) {
            const browser = BROWSERS[i];

            robot.log(`Creating a check run for the screenshotter of ${browser}`);
            // https://developer.github.com/v3/checks/runs/#create-a-check-run
            context.github.checks.create(context.repo({
                name: CHECK_NAME(browser),
                head_branch: checkSuite.head_branch,
                head_sha: checkSuite.head_sha,
                status: 'in_progress',
                // https://github.com/octokit/rest.js/issues/862
                conclusion: 'neutral',
                completed_at: checkSuite.created_at,
                output: {
                    title: 'Screenshotter Running',
                    summary: `The verification of screenshots on ${browser}` +
                        ' is **running**.',
                },
                // https://github.com/octokit/rest.js/issues/861
                headers: {
                    accept: 'application/vnd.github.antiope-preview+json',
                },
            }));
        }
    });

    // https://developer.github.com/v3/activity/events/types/#statusevent
    robot.on('status', async context => {
        const payload = context.payload;
        const state = payload.state;
        const stateContext = payload.context;
        robot.log(`Received ${state} status for ${stateContext}`);
        if (state === 'pending' || !stateContext.startsWith('ci/circleci:')) {
            return;
        }
        const browser = stateContext.charAt(13).toUpperCase() +
            stateContext.substr(14);
        if (BROWSERS.indexOf(browser) === -1) {
            return;
        }
        robot.log(`Status for the screenshotter of ${browser} updated`);

        // https://developer.github.com/v3/checks/runs/#list-check-runs-for-a-specific-ref
        const checksList = await context.github.checks.listForRef(context.repo({
            check_name: CHECK_NAME(browser),
            ref: payload.sha,
            headers: {
                accept: 'application/vnd.github.antiope-preview+json',
            },
        }));
        const data = checksList.data;
        if (!data.check_runs || data.check_runs.length === 0) {
            robot.log.error(`Check run for screenshotter of ${browser} not found!`);
            return;
        }
        const check = data.check_runs[0];

        // https://developer.github.com/v3/checks/runs/#update-a-check-run
        const params = context.repo({
            check_run_id: check.id,
            name: check.name,
            details_url: payload.target_url,
            status: 'completed',
            completed_at: payload.updated_at,
            headers: {
                accept: 'application/vnd.github.antiope-preview+json',
            },
        });

        switch (payload.state) {
            case 'success':
                params.conclusion = 'success';
                params.output = {
                    title: 'Screenshotter Passed',
                    summary: `The verification of screenshots on ${browser}` +
                        ' **passed**.',
                };
                break;

            case 'failure': {
                const path = url.parse(payload.target_url).pathname;
                if (!path) {
                    robot.log.error('Invalid target_url');
                    return;
                }
                const parts = path.substr(1).split('/');
                if (parts.length !== 4) {
                    robot.log.error(`Invalid target_url format: ${path}`);
                    return;
                }

                robot.log('Getting artifacts list from CircleCI');
                // https://circleci.com/docs/api/v1-reference/#build-artifacts
                const response = await got.get('https://circleci.com/api/v1.1/project' +
                    `/github/${parts[1]}/${parts[2]}/${parts[3]}/artifacts`, {
                        headers: {
                            Accept: 'application/json',
                        },
                        json: true,
                    });
                const artifacts = response.body;
                if (!Array.isArray(artifacts)) {
                    robot.log.error(`Invalid response: ${artifacts}`);
                    return;
                }

                let text = '';
                for (let i = 0; i < artifacts.length; i++) {
                    if (artifacts[i].path.startsWith('diff/')) {
                        const imagePath = artifacts[i].path;
                        const testName = imagePath.substring(5,
                            imagePath.indexOf('-'));

                        let newUrl = '';
                        for (let j = 0; j < artifacts.length; j++) {
                            if (artifacts[j].path.startsWith(`image/${testName}`)) {
                                newUrl = artifacts[j].url;
                                break;
                            }
                        }

                        robot.log(`${testName} failed`);
                        text += `## ${testName}
![${testName}](${artifacts[i].url})
[[New Screenshot]](${newUrl})

`;
                    }
                }

                params.conclusion = 'failure';
                params.output = {
                    title: 'Screenshotter Failed',
                    summary: 'The verification of following screenshots on ' +
                        `${browser} **failed**:`,
                    text,
                };
                break;
            }

            case 'error':
                params.conclusion = 'action_required';
                params.output = {
                    title: 'Screenshotter Errored',
                    summary: payload.description,
                };
                break;

            default:
                robot.log.error(`Unknown state: ${state}`);
                return;
        }

        robot.log(`Updating a check run for the screenshotter of ${browser}`);
        context.github.checks.update(params);
    });
};
