import { App } from 'aws-cdk-lib'
import { config } from '../lib/config.ts'
import { SubstrateMacStack } from '../lib/mac-stack.ts'
import { SubstrateStack } from '../lib/substrate-stack.ts'

const app = new App()

new SubstrateStack(app, config.stackName, {
  // The account comes from whoever's credentials run the deploy.
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: config.region },
  description: 'Substrate: persistent microVM sandboxes for coding agents',
})

new SubstrateMacStack(app, config.mac.stackName, {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: config.mac.region },
  description: 'Substrate: the network for EC2 Mac hosts (macOS workspaces)',
})
