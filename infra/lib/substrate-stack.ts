import { CfnOutput, Duration, Fn, RemovalPolicy, Size, Stack, Tags, type StackProps } from 'aws-cdk-lib'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as dlm from 'aws-cdk-lib/aws-dlm'
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as ssm from 'aws-cdk-lib/aws-ssm'
import type { Construct } from 'constructs'
import { config } from './config.ts'

export class SubstrateStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props)
    Tags.of(this).add('project', 'substrate')

    // One public subnet and no NAT gateway. Nothing accepts traffic from the
    // internet: CloudFront reaches the control box, the control box reaches the
    // host, and admins come in through SSM.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(config.vpcCidr),
      availabilityZones: [config.availabilityZone],
      natGateways: 0,
      subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
    })

    // Build artifacts (setup scripts, binaries, later the guest kernel and rootfs).
    // Everything in it can be rebuilt, so it goes away with the stack.
    const artifacts = new s3.Bucket(this, 'Artifacts', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    })

    const controlSg = new ec2.SecurityGroup(this, 'ControlSg', {
      vpc,
      description: 'Substrate control box: reachable from CloudFront only',
    })
    controlSg.addIngressRule(
      ec2.Peer.prefixList(config.cloudFrontPrefixList),
      ec2.Port.tcp(config.control.port),
      'CloudFront to the control API',
    )

    const hostSg = new ec2.SecurityGroup(this, 'HostSg', {
      vpc,
      description: 'Substrate sandbox host: reachable from the control box only',
    })
    hostSg.addIngressRule(controlSg, ec2.Port.tcp(config.host.hostdPort), 'Control box to hostd')

    const ssmCore = iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')
    const readSubstrateParams = new iam.PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:GetParameters'],
      resources: [this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: 'substrate/*' })],
    })

    // Sandbox host.
    const hostRole = new iam.Role(this, 'HostRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [ssmCore],
    })
    artifacts.grantRead(hostRole, 'host/*')
    hostRole.addToPolicy(readSubstrateParams)

    const hostData = new ec2.Volume(this, 'HostData', {
      availabilityZone: config.availabilityZone,
      size: Size.gibibytes(config.host.dataGiB),
      volumeType: ec2.EbsDeviceVolumeType.GP3,
      encrypted: true,
      // Holds the ZFS pool with every VM, so it outlives the host and the stack.
      removalPolicy: RemovalPolicy.RETAIN,
      volumeName: 'substrate-host-data',
    })

    // Daily snapshots of the data disk, by Data Lifecycle Manager. ZFS keeps
    // its pool consistent on disk at every moment, so a snapshot of the live
    // disk restores like a power cut: at most seconds of writes lost.
    Tags.of(hostData).add('substrate:backup', 'daily')
    const snapshotRole = new iam.Role(this, 'DataSnapshotRole', {
      assumedBy: new iam.ServicePrincipal('dlm.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSDataLifecycleManagerServiceRole')],
    })
    new dlm.CfnLifecyclePolicy(this, 'DataSnapshots', {
      description: 'Substrate daily snapshots of the host data disk',
      state: 'ENABLED',
      executionRoleArn: snapshotRole.roleArn,
      policyDetails: {
        policyType: 'EBS_SNAPSHOT_MANAGEMENT',
        resourceTypes: ['VOLUME'],
        targetTags: [{ key: 'substrate:backup', value: 'daily' }],
        schedules: [
          {
            name: 'Daily',
            createRule: { interval: 24, intervalUnit: 'HOURS', times: [config.host.dataSnapshots.time] },
            retainRule: { count: config.host.dataSnapshots.keep },
            copyTags: true,
            tagsToAdd: [{ key: 'substrate:snapshot', value: 'daily' }],
          },
        ],
      },
    })

    const hostUserData = ec2.UserData.forLinux()
    hostUserData.addCommands(
      'mkdir -p /etc/substrate /opt/substrate',
      `cat > /etc/substrate/host.env <<'EOF'`,
      `SUBSTRATE_REGION=${config.region}`,
      `SUBSTRATE_BUCKET=${artifacts.bucketName}`,
      `SUBSTRATE_DATA_VOLUME=${hostData.volumeId}`,
      'EOF',
      'snap install aws-cli --classic',
      'export PATH="$PATH:/snap/bin"',
      // A replacement host re-runs the last deployed setup. A brand-new stack has
      // none yet; `bun run setup:host` provides it.
      `if aws s3 cp s3://${artifacts.bucketName}/host/setup-host.sh /opt/substrate/setup-host.sh; then bash /opt/substrate/setup-host.sh; fi`,
    )

    // Nested virtualization can only be switched on through a launch template.
    // Keep this template unchanged: a new template version replaces the host.
    const hostTemplate = new ec2.CfnLaunchTemplate(this, 'HostTemplate', {
      launchTemplateData: {
        metadataOptions: { httpEndpoint: 'enabled', httpTokens: 'required', httpPutResponseHopLimit: 1 },
      },
    })
    hostTemplate.addPropertyOverride('LaunchTemplateData.CpuOptions.NestedVirtualization', 'enabled')

    const host = new ec2.Instance(this, 'Host', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      availabilityZone: config.availabilityZone,
      instanceType: new ec2.InstanceType(config.host.instanceType),
      machineImage: ec2.MachineImage.genericLinux({ [config.region]: config.host.ami }),
      securityGroup: hostSg,
      role: hostRole,
      userData: hostUserData,
      instanceName: 'substrate-host',
      blockDevices: [
        {
          deviceName: '/dev/sda1',
          volume: ec2.BlockDeviceVolume.ebs(config.host.rootGiB, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
          }),
        },
      ],
    })
    const cfnHost = host.node.defaultChild as ec2.CfnInstance
    cfnHost.launchTemplate = {
      launchTemplateId: hostTemplate.ref,
      version: hostTemplate.attrLatestVersionNumber,
    }

    new ec2.CfnVolumeAttachment(this, 'HostDataAttachment', {
      instanceId: host.instanceId,
      volumeId: hostData.volumeId,
      device: '/dev/sdf',
    })

    // Control box.
    const controlRole = new iam.Role(this, 'ControlRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [ssmCore],
    })
    artifacts.grantRead(controlRole, 'control/*')
    controlRole.addToPolicy(readSubstrateParams)
    controlRole.addToPolicy(
      new iam.PolicyStatement({ actions: ['ec2:DescribeInstances'], resources: ['*'] }),
    )
    // macOS workspaces (M10). Each Mac host's instance gets this role: admin
    // access over SSM, and its agent from the artifacts bucket. IAM is global,
    // so it lives here although the Macs run in config.mac.region.
    const macRole = new iam.Role(this, 'MacRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [ssmCore],
    })
    artifacts.grantRead(macRole, 'mac/*')
    new iam.InstanceProfile(this, 'MacInstanceProfile', { role: macRole, instanceProfileName: config.mac.instanceProfile })
    // The control box allocates Mac hosts on demand and releases idle ones, in
    // the Mac region only. It may end only the instances and hosts it tagged.
    const inMacRegion = { StringEquals: { 'aws:RequestedRegion': config.mac.region } }
    controlRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ec2:DescribeHosts', 'ec2:DescribeSubnets', 'ec2:DescribeSecurityGroups', 'ec2:DescribeImages', 'ec2:AllocateHosts', 'ec2:RunInstances'],
        resources: ['*'],
        conditions: inMacRegion,
      }),
    )
    controlRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ec2:CreateTags'],
        resources: ['*'],
        conditions: { ...inMacRegion, StringEquals: { ...inMacRegion.StringEquals, 'ec2:CreateAction': ['AllocateHosts', 'RunInstances'] } },
      }),
    )
    controlRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ec2:TerminateInstances', 'ec2:ReleaseHosts'],
        resources: ['*'],
        conditions: { StringEquals: { 'aws:RequestedRegion': config.mac.region }, StringLike: { 'ec2:ResourceTag/substrate:mac': '*' } },
      }),
    )
    controlRole.addToPolicy(new iam.PolicyStatement({ actions: ['iam:PassRole'], resources: [macRole.roleArn] }))
    // The latest macOS image, from AWS's public parameters.
    controlRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [`arn:${this.partition}:ssm:${config.mac.region}::parameter/aws/service/ec2-macos/*`],
      }),
    )

    // For M5, where the control box stops the host when every VM is idle.
    controlRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ec2:StartInstances', 'ec2:StopInstances'],
        resources: [
          this.formatArn({ service: 'ec2', resource: 'instance', resourceName: host.instanceId }),
        ],
      }),
    )

    const controlUserData = ec2.UserData.forLinux()
    controlUserData.addCommands(
      'mkdir -p /etc/substrate /opt/substrate',
      `cat > /etc/substrate/control.env <<'EOF'`,
      `AWS_REGION=${config.region}`,
      `PORT=${config.control.port}`,
      `SUBSTRATE_BUCKET=${artifacts.bucketName}`,
      `SUBSTRATE_HOST_INSTANCE_ID=${host.instanceId}`,
      'EOF',
      `if aws s3 cp s3://${artifacts.bucketName}/control/setup-control.sh /opt/substrate/setup-control.sh; then bash /opt/substrate/setup-control.sh; fi`,
    )

    const control = new ec2.Instance(this, 'Control', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      availabilityZone: config.availabilityZone,
      instanceType: new ec2.InstanceType(config.control.instanceType),
      machineImage: ec2.MachineImage.genericLinux({ [config.region]: config.control.ami }),
      securityGroup: controlSg,
      role: controlRole,
      userData: controlUserData,
      instanceName: 'substrate-control',
      // Amazon Linux 2023 already requires IMDSv2.
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(config.control.rootGiB, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
          }),
        },
      ],
    })

    // A fixed address, so CloudFront's origin never changes.
    const controlIp = new ec2.CfnEIP(this, 'ControlIp', {
      instanceId: control.instanceId,
      tags: [{ key: 'Name', value: 'substrate-control' }],
    })
    // CloudFront needs a hostname, not an IP: use the EIP's public EC2 DNS name.
    const controlHostname = Fn.join('', [
      'ec2-',
      Fn.join('-', Fn.split('.', controlIp.ref)),
      `.${config.region}.compute.amazonaws.com`,
    ])

    // The public HTTPS URL. CloudFront terminates TLS, so no domain is needed.
    const web = new cloudfront.Distribution(this, 'Web', {
      comment: 'Substrate',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        origin: new origins.HttpOrigin(controlHostname, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
          httpPort: config.control.port,
          readTimeout: Duration.seconds(60),
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
      },
    })

    new CfnOutput(this, 'Url', { value: `https://${web.distributionDomainName}` })
    // Where Macs' agents dial in (M10).
    new ssm.StringParameter(this, 'PublicUrl', { parameterName: '/substrate/public-url', stringValue: `https://${web.distributionDomainName}` })
    const previews = new cloudfront.Distribution(this, 'Previews', {
      comment: 'Substrate workspace previews',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      defaultBehavior: {
        origin: new origins.HttpOrigin(controlHostname, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
          httpPort: config.control.port,
          readTimeout: Duration.seconds(60),
          customHeaders: { 'x-substrate-preview': '1' },
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
      },
    })
    new ssm.StringParameter(this, 'PreviewOrigin', { parameterName: '/substrate/preview-origin', stringValue: `https://${previews.distributionDomainName}` })
    new CfnOutput(this, 'PreviewUrl', { value: `https://${previews.distributionDomainName}` })
    new CfnOutput(this, 'ArtifactsBucket', { value: artifacts.bucketName })
    new CfnOutput(this, 'ControlInstanceId', { value: control.instanceId })
    new CfnOutput(this, 'HostInstanceId', { value: host.instanceId })
    new CfnOutput(this, 'HostDataVolumeId', { value: hostData.volumeId })
  }
}
