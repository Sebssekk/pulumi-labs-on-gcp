import * as gcp from "@pulumi/gcp";

export const VMSLab = (opts : { 
    labName : string, 
    vmNum: number, 
    vmId: string, 
    vmType: string,
    public: boolean,
    userData: string,
    region: string,
    pubKey: string,
    sa? : gcp.serviceaccount.Account,
    vpc?: gcp.compute.Network,
    subnets? : gcp.compute.Subnetwork[],
    publiclyOpenedFwPorts? : string[],
    image?: string,
    osUsername?: string,
    extraMetada?: any
}) => {
    
    const osUsername = opts.osUsername ? opts.osUsername :"ubuntu"
    const image = opts.image ? opts.image : "ubuntu-2204-lts"
    
    const sa = opts.sa ? opts.sa : new gcp.serviceaccount.Account(`${opts.labName}-${opts.vmId}-sa`, {
        accountId: `${opts.labName}-${opts.vmId}-sa`,
        displayName: `SA for ${opts.labName}-${opts.vmId} VMs`,
    })

    const vpc : gcp.compute.Network = opts.vpc ? opts.vpc : new gcp.compute.Network(`${opts.labName}-VMS-vpc`, {
        name: `${opts.labName}-vms-vpc`,
        autoCreateSubnetworks: false,
    })

    const subnets : gcp.compute.Subnetwork[] = opts.subnets ? opts.subnets : [
        new gcp.compute.Subnetwork(`${opts.labName}-VMS-subnet-1`, {
            name: `${opts.labName}-vms-subnet-1`,
            network: vpc.id,
            ipCidrRange: "192.168.1.0/24",
            region: `${opts.region}`
        }),
        new gcp.compute.Subnetwork(`${opts.labName}-VMS-subnet-2`, {
            name: `${opts.labName}-vms-subnet-2`,
            network: vpc.id,
            ipCidrRange: "192.168.2.0/24",
            region: `${opts.region}`
        }),
    ]
    
    const openedFwPorts = opts.publiclyOpenedFwPorts ? opts.publiclyOpenedFwPorts : [
        "80",
        "443",
        "22"
    ]
    openedFwPorts.length > 0 ? new gcp.compute.Firewall(`${opts.labName}-${opts.vmId}-PubliclyOpened-FW-rule`, {
        name: `${opts.labName}-${opts.vmId}-publiclyopened-fw-rule`,
        network: vpc.id,
        description: `Publicly reachable port for ${opts.labName}/${opts.vmId} instances`,
        allows: [{
            protocol: "tcp",
            ports: openedFwPorts,
        }],
        sourceRanges: ["0.0.0.0/0"],
        targetServiceAccounts: [sa.email],
    }) : null


    const vms : gcp.compute.Instance[] = []
    Array.from(new Array(opts.vmNum)).forEach((_,i) => {
        let pubIp : gcp.compute.Address | null = null;
        if (opts.public ){
            pubIp = new gcp.compute.Address(`${opts.labName}-${opts.vmId}-${i}-pub-ip`, {
                addressType: "EXTERNAL",
                ipVersion: "IPV4",
                region: `${opts.region}`,
            })
        }

        vms.push( new gcp.compute.Instance(`${opts.labName}-${opts.vmId}-${i}`, {
            zone: `${opts.region}-${i % 3 ? i=== 2 ? 'a' : 'b' : 'c' }`,
            networkInterfaces: [{
                subnetwork: subnets[i%subnets.length].id,
                ...opts.public ? 
                { accessConfigs: [
                     {natIp: pubIp!.address} 
                ]} : {}
            }],
            name: `${opts.labName}-${opts.vmId}-${i}`,
            machineType: opts.vmType,
            bootDisk: {
                initializeParams: {
                    architecture: "X86_64",
                    image: image,
                },
            },
            metadataStartupScript: opts.userData,
            metadata: {
                'enable-oslogin': 'false',
                'ssh-keys': osUsername+ ':' + opts.pubKey,
                ...opts.extraMetada
            },
            serviceAccount: {
                email: sa.email,
                scopes: ["cloud-platform"],
            },
        }))
    })

    return vms
}


