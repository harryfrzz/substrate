import {
  AllocateHostsCommand,
  DescribeImagesCommand,
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
  EC2Client,
  ReleaseHostsCommand,
  RunInstancesCommand,
  TerminateInstancesCommand,
  type _InstanceType,
} from '@aws-sdk/client-ec2'
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm'

// What the pool needs from EC2; tests substitute a fake.
export interface MacCloud {
  // Allocates a Mac host in one of these AZs; EC2 bills it for 24 hours at least.
  allocateHost(availabilityZones: readonly string[]): Promise<{ hostId: string; az: string }>
  // Starts the host's instance, which runs `userData` as root at first boot.
  launch(input: { hostId: string; az: string; userData: string }): Promise<string>
  terminate(instanceId: string): Promise<void>
  // False while EC2 won't release it yet (e.g. its instance is still shutting down).
  release(hostId: string): Promise<boolean>
}

type Options = {
  region: string
  instanceType: _InstanceType
  // A name under /aws/service/ec2-macos, e.g. sequoia.
  macos: string
  instanceProfile: string
  rootGiB: number
}

const tags = (kind: string) => [
  { Key: 'project', Value: 'substrate' },
  { Key: 'substrate:mac', Value: kind },
  { Key: 'Name', Value: `substrate-mac-${kind}` },
]

export function awsMacCloud({ region, instanceType, macos, instanceProfile, rootGiB }: Options): MacCloud {
  const ec2 = new EC2Client({ region })
  const ssm = new SSMClient({ region })

  // The SubstrateMac stack's subnets (one per AZ) and security group, by tag.
  let network: Promise<{ subnets: Map<string, string>; securityGroup: string }> | null = null
  const findNetwork = () =>
    (network ??= (async () => {
      const filter = (value: string) => [{ Name: 'tag:substrate:mac', Values: [value] }]
      const { Subnets = [] } = await ec2.send(new DescribeSubnetsCommand({ Filters: filter('subnet') }))
      const { SecurityGroups = [] } = await ec2.send(new DescribeSecurityGroupsCommand({ Filters: filter('security-group') }))
      const securityGroup = SecurityGroups[0]?.GroupId
      if (!Subnets.length || !securityGroup) throw new Error(`no Mac network in ${region}: deploy the SubstrateMac stack`)
      return { subnets: new Map(Subnets.map((s) => [s.AvailabilityZone!, s.SubnetId!])), securityGroup }
    })().catch((err) => {
      network = null
      throw err
    }))

  return {
    async allocateHost(availabilityZones) {
      let lastError: unknown
      for (const az of availabilityZones) {
        try {
          const { HostIds = [] } = await ec2.send(
            new AllocateHostsCommand({
              InstanceType: instanceType,
              AvailabilityZone: az,
              Quantity: 1,
              AutoPlacement: 'off',
              TagSpecifications: [{ ResourceType: 'dedicated-host', Tags: tags('host') }],
            }),
          )
          if (HostIds[0]) return { hostId: HostIds[0], az }
        } catch (err) {
          // Out of capacity in this AZ: try the next. Anything else (like the
          // account's quota) won't be different elsewhere.
          lastError = err
          if (!(err instanceof Error && /InsufficientHostCapacity|InsufficientCapacity/.test(err.name))) throw err
        }
      }
      throw lastError ?? new Error('no availability zone to allocate a Mac host in')
    },

    async launch({ hostId, az, userData }) {
      const { subnets, securityGroup } = await findNetwork()
      const subnet = subnets.get(az)
      if (!subnet) throw new Error(`no Mac subnet in ${az}`)
      const imageId = (await ssm.send(new GetParameterCommand({ Name: `/aws/service/ec2-macos/${macos}/arm64_mac/latest/image_id` })))
        .Parameter?.Value
      if (!imageId) throw new Error(`no macOS ${macos} image in ${region}`)
      const { Images = [] } = await ec2.send(new DescribeImagesCommand({ ImageIds: [imageId] }))
      const { Instances = [] } = await ec2.send(
        new RunInstancesCommand({
          ImageId: imageId,
          InstanceType: instanceType,
          MinCount: 1,
          MaxCount: 1,
          Placement: { HostId: hostId, Tenancy: 'host' },
          SubnetId: subnet,
          SecurityGroupIds: [securityGroup],
          IamInstanceProfile: { Name: instanceProfile },
          UserData: Buffer.from(userData).toString('base64'),
          // A hop limit of 1 keeps the metadata service (and so the host's
          // credentials and this user data, which holds its agent token) out
          // of reach of the macOS VMs NATed behind it.
          MetadataOptions: { HttpTokens: 'required', HttpPutResponseHopLimit: 1, HttpEndpoint: 'enabled' },
          BlockDeviceMappings: [
            {
              DeviceName: Images[0]?.RootDeviceName ?? '/dev/sda1',
              Ebs: { VolumeSize: rootGiB, VolumeType: 'gp3', Encrypted: true, DeleteOnTermination: true },
            },
          ],
          TagSpecifications: [
            { ResourceType: 'instance', Tags: tags('instance') },
            { ResourceType: 'volume', Tags: tags('volume') },
          ],
        }),
      )
      const instanceId = Instances[0]?.InstanceId
      if (!instanceId) throw new Error('EC2 started no instance')
      return instanceId
    },

    async terminate(instanceId) {
      await ec2.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }))
    },

    async release(hostId) {
      const { Successful = [] } = await ec2.send(new ReleaseHostsCommand({ HostIds: [hostId] }))
      return Successful.includes(hostId)
    },
  }
}
