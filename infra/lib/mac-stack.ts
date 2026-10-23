import { CfnOutput, Stack, Tags, type StackProps } from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import type { Construct } from 'constructs'
import { config } from './config.ts'

// The network EC2 Mac hosts live in (M10). Hosts and their instances aren't
// here: the control box allocates and releases them on demand, finding this
// subnet and security group by their `substrate:mac` tag.
export class SubstrateMacStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props)
    Tags.of(this).add('project', 'substrate')

    // Public subnets without a NAT gateway, as in Mumbai. Nothing is let in:
    // each Mac's agent dials out to the control box over the public URL.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(config.mac.vpcCidr),
      availabilityZones: [...config.mac.availabilityZones],
      natGateways: 0,
      subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
    })
    for (const subnet of vpc.publicSubnets) Tags.of(subnet).add('substrate:mac', 'subnet')

    const sg = new ec2.SecurityGroup(this, 'MacSg', {
      vpc,
      description: 'Substrate Mac hosts: no inbound, the agent dials out',
      allowAllOutbound: true,
    })
    Tags.of(sg).add('substrate:mac', 'security-group')

    new CfnOutput(this, 'VpcId', { value: vpc.vpcId })
  }
}
