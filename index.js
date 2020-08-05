const got = require('got')

const BROWSERS = ['Firefox', 'Chrome']
const CHECK_NAME = browser => `Screenshotter - ${browser}`

function createCheckRuns (robot, context, checkSuite) {
  for (let i = 0; i < BROWSERS.length; i++) {
    const browser = BROWSERS[i]

    robot.log(`Creating a check run for the screenshotter of ${browser}`)
    // https://developer.github.com/v3/checks/runs/#create-a-check-run
    context.github.checks.create(context.repo({
      name: CHECK_NAME(browser),
      head_sha: checkSuite.head_sha,
      status: 'in_progress',
      output: {
        title: 'Screenshotter Running',
        summary: `The verification of screenshots on ${browser}` +
                    ' is **running**.'
      }
    }))
  }
}

module.exports = (robot) => {
  robot.log('The app is successfully loaded!')

  // check suite is not automatically created for pull requests
  // https://platform.github.community/t/checks-api-and-cross-repository-pull-requests/5858

  // https://developer.github.com/v3/activity/events/types/#pullrequestevent
  robot.on(['pull_request.opened', 'pull_request.synchronize'], async context => {
    const payload = context.payload
    const pullRequest = payload.pull_request
    robot.log(`Received pull_request.${payload.action} from ` +
            `${pullRequest.head.repo.full_name}`)

    if (pullRequest.head.repo.full_name === pullRequest.base.repo.full_name) {
      return
    }

    robot.log(`Creating a check suite for ${pullRequest.head.sha}`)
    const checkSuite = await context.github.checks.createSuite(context.repo({
      head_sha: pullRequest.head.sha
    }))
    createCheckRuns(robot, context, checkSuite.data)
  })

  // https://developer.github.com/v3/activity/events/types/#checksuiteevent
  robot.on('check_suite.requested', async context => {
    robot.log('Received check_suite.requested')
    const payload = context.payload
    const checkSuite = payload.check_suite
    if (checkSuite.head_branch === 'gh-pages') {
      return
    }
    createCheckRuns(robot, context, checkSuite)
  })

  // https://developer.github.com/v3/activity/events/types/#statusevent
  // it is assumed that `check_suite.requested` has been received and
  // check runs have been created, before CircleCI test completes
  robot.on('status', async context => {
    const payload = context.payload
    const state = payload.state
    const stateContext = payload.context
    robot.log(`Received ${state} status for ${stateContext}`)
    if (state === 'pending' || !stateContext.startsWith('ci/circleci:')) {
      return
    }

    const browser = stateContext.charAt(13).toUpperCase() +
            stateContext.substr(14)
    if (BROWSERS.indexOf(browser) === -1) {
      return
    }
    robot.log(`Status for the screenshotter of ${browser} updated`)

    // https://developer.github.com/v3/checks/runs/#list-check-runs-for-a-specific-ref
    const checksList = await context.github.checks.listForRef(context.repo({
      check_name: CHECK_NAME(browser),
      ref: payload.sha
    }))
    const data = checksList.data
    if (!data.check_runs || data.check_runs.length === 0) {
      robot.log.error(`Check run for screenshotter of ${browser} not found!`)
      return
    }
    const check = data.check_runs[0]

    // https://developer.github.com/v3/checks/runs/#update-a-check-run
    const params = context.repo({
      check_run_id: check.id,
      name: check.name,
      details_url: payload.target_url,
      status: 'completed',
      completed_at: payload.updated_at
    })

    switch (payload.state) {
      case 'success':
        params.conclusion = 'success'
        params.output = {
          title: 'Screenshotter Passed',
          summary: `The verification of screenshots on ${browser}` +
                        ' **passed**.'
        }
        break

      case 'failure': {
        const path = new URL(payload.target_url).pathname
        if (!path) {
          robot.log.error('Invalid target_url')
          return
        }
        const parts = path.substr(1).split('/')
        if (parts.length !== 4) {
          robot.log.error(`Invalid target_url format: ${path}`)
          return
        }

        robot.log('Getting artifacts list from CircleCI')
        // https://circleci.com/docs/api/v1-reference/#build-artifacts
        const artifacts = await got.get('https://circleci.com/api/v1.1/project' +
                    `/github/${parts[1]}/${parts[2]}/${parts[3]}/artifacts`, {
          headers: {
            Accept: 'application/json'
          }
        }).json()
        if (!Array.isArray(artifacts)) {
          robot.log.error(`Invalid response: ${artifacts}`)
          return
        }

        let text = ''
        const failedTests = []
        for (let i = 0; i < artifacts.length; i++) {
          if (artifacts[i].path.startsWith('diff/')) {
            const imagePath = artifacts[i].path
            const testName = imagePath.substring(5,
              imagePath.indexOf('-'))

            let newUrl = ''
            for (let j = 0; j < artifacts.length; j++) {
              if (artifacts[j].path.startsWith(`new/${testName}`)) {
                newUrl = artifacts[j].url
                break
              }
            }

            failedTests.push(testName)
            text += `## ${testName}
![${testName}](${artifacts[i].url})
[[New Screenshot]](${newUrl})

`
          }
        }
        const failedList = failedTests.join(', ')

        robot.log(`${failedList} failed`)
        params.conclusion = 'failure'
        params.output = {
          title: 'Screenshotter Failed',
          summary: 'The verification of following screenshots on ' +
                        `${browser} **failed**: ${failedList}`,
          text
        }
        break
      }

      case 'error':
        params.conclusion = 'action_required'
        params.output = {
          title: 'Screenshotter Errored',
          summary: payload.description
        }
        break

      default:
        robot.log.error(`Unknown state: ${state}`)
        return
    }

    robot.log(`Updating a check run for the screenshotter of ${browser}`)
    context.github.checks.update(params)
  })
}
