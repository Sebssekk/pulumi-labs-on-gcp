import * as gcp from "@pulumi/gcp";
import {VMSLab} from "./VMStack";
import {WaitForGuestOSCondition} from "../customs/VmReady";
import * as fs from "node:fs"
import * as Mustache from "mustache"
import * as pulumi from "@pulumi/pulumi";


export const K8SLab = (opts : { 
    labName : string,
    bastion: boolean,
    accessNum: number 
    clustersNum: number,
    workersNum: number, 
    region: string,
    privKey: string,
    pubKey: string,
    clusterReady: boolean
    k8s_version?: string,
    etcd_version?: string,
    cilium_version?: string,
    accessPsw?: string,
    osUsername?: string,
    vmType?: string,
    vpc?: gcp.compute.Network,
    subnets? : gcp.compute.Subnetwork[],
}) => {

    const ret : {'access' : gcp.compute.Instance | null, 'clusters' : {'cp' :gcp.compute.Instance[], 'wks':gcp.compute.Instance[] }[], 'config-bucket': gcp.storage.Bucket | null} = {
        'access' : null,
        'clusters' : [],
        'config-bucket': null
    }

    const ACCESS_PSW = opts.accessPsw || "lab123"

    const configBucket = new gcp.storage.Bucket(`${opts.labName}-config-bucket`, {
        name: `${opts.labName}-k8s-config-bucket-${Math.floor((Math.random()*100000))}`,
        location: `${opts.region}`,
        forceDestroy: true
    })

    ret['config-bucket'] = configBucket;

    fs.readdirSync("./config/K8S/remote").forEach(file => {
        new gcp.storage.BucketObject(`${opts.labName}-remote-configs-${file}`, {
            name: file,
            source: `./config/K8S/remote/${file}`,
            bucket: configBucket.id
        })
    })
    new gcp.storage.BucketObject(`${opts.labName}-remote-configs-priv-ssh`, {
        name: 'key.pem',
        source: `./key.pem`,
        bucket: configBucket.id
    })
    

    const vpc = opts.vpc ? opts.vpc : new gcp.compute.Network(`${opts.labName}-K8S-vpc`, {
            name: `${opts.labName}-k8s-vpc`,
            autoCreateSubnetworks: false,
        })
    
    const subnets = opts.subnets ? opts.subnets : [
        ...opts.bastion ? [ new gcp.compute.Subnetwork(`${opts.labName}-ACCESS-subnet`, {
            name: `${opts.labName}-access-subnet`,
            network: vpc.id,
            ipCidrRange: "192.168.99.0/24",
            region: `${opts.region}`
        })] : [],
        new gcp.compute.Subnetwork(`${opts.labName}-K8S-subnet-1`, {
            name: `${opts.labName}-k8s-subnet-1`,
            network: vpc.id,
            ipCidrRange: "192.168.1.0/24",
            region: `${opts.region}`,
            privateIpGoogleAccess: true
        }),
        new gcp.compute.Subnetwork(`${opts.labName}-K8S-subnet-2`, {
            name: `${opts.labName}-k8s-subnet-2`,
            network: vpc.id,
            ipCidrRange: "192.168.2.0/24",
            region: `${opts.region}`,
            privateIpGoogleAccess: true
        }),
    ]

    let bastionSa : gcp.serviceaccount.Account | null = null;

    if (opts.bastion){
        const router = new gcp.compute.Router(`${opts.labName}-K8S-nat-router`, {
            name: `${opts.labName}-k8s-nat-router`,
            region: opts.region,
            network: vpc.id,
        });
        new gcp.compute.RouterNat(`${opts.labName}-K8Snat-gateway`, {
            name: `${opts.labName}-k8s-nat-gateway`,        
            router: router.name,
            region: opts.region,
            sourceSubnetworkIpRangesToNat: "ALL_SUBNETWORKS_ALL_IP_RANGES",
            natIpAllocateOption: "AUTO_ONLY"
        });
        bastionSa = new gcp.serviceaccount.Account(`${opts.labName}-bastion-sa`, {
            accountId: `${opts.labName}-bastion-sa`,
            displayName: `SA for ${opts.labName}-bastion`,
        })

        const bastionRole = new gcp.projects.IAMCustomRole(`${opts.labName}-bastion-role`, {
            roleId: `${opts.labName}BastionRole`,
            title: `Role for K8S bastion - lab ${opts.labName}`,
            permissions: [
                // ** To get remote config files **
                "storage.objects.get",
                "storage.objects.list",
                // ** To view k8s vms details **
                "compute.instances.get",
                "compute.instances.list",
                "compute.instances.getGuestAttributes"

            ],
        });

        new gcp.projects.IAMBinding(`${opts.labName}-bastion-binding`, {
            role: bastionRole.id,
            members: [pulumi.interpolate `serviceAccount:${bastionSa.email}`],
            project: gcp.config.project!,
        })

        new gcp.storage.BucketIAMBinding(`${opts.labName}-bastion-bucket-binding`, {
            bucket: configBucket.id,
            role: bastionRole.id,
            members: [pulumi.interpolate `serviceAccount:${bastionSa.email}`],
        })

        const bastionUserData = Mustache.render(fs.readFileSync("./config/K8S/userData/bastion.sh",{encoding:"utf-8"}),{
            ACCESS_PSW: ACCESS_PSW,
            LAB_NAME: opts.labName,
            CLUSTERS_NUM: opts.clustersNum,
            OS_USERNAME: opts.osUsername || "ubuntu",
            K8S_VERSION: opts.k8s_version || "1.35",
            ACCESS_NUM: opts.accessNum,
            CLUSTER_READY: opts.clusterReady
        })

        const accessVM = VMSLab({
            labName:opts.labName, 
            vmType: "e2-standard-8",
            vmNum: 1, 
            vmId: `bastion` , 
            public: true,
            userData: bastionUserData,
            region: opts.region,
            pubKey: opts.pubKey,
            sa: bastionSa,
            osUsername: opts.osUsername,
            vpc: vpc,
            subnets: subnets.slice(0,1),
            publiclyOpenedFwPorts: ["22", ...Array.from(new Array(opts.accessNum + 1)).map((_,i) => `${8080+i}` )],
            extraMetada: {
                "enable-guest-attributes": "TRUE",
                'config-bucket': configBucket.name
            }
        })

        new WaitForGuestOSCondition(`wait-for-${opts.labName}-bastion`, {
            project: gcp.config.project!,
            zone: accessVM[0].zone,
            vmName: accessVM[0].name,
            expectedValue: 'completed',
            queryPath: 'status/startup',
            credentials: gcp.config.credentials,
        }, {
            dependsOn: accessVM[0]
        });

        ret["access"] = accessVM[0];
    }

    const k8sSa = new gcp.serviceaccount.Account(`${opts.labName}-k8s-sa`, {
        accountId: `${opts.labName}-k8s-sa`,
        displayName: `SA for ${opts.labName} k8s nodes`,
    })

    const k8sRole = new gcp.projects.IAMCustomRole(`${opts.labName}-k8s-role`, {
        roleId: `${opts.labName}K8sRole`,
        title: `Role for K8S Nodes - lab ${opts.labName}`,
        permissions: [
            "storage.objects.get",
            "storage.objects.list",
            // ** To view k8s vms details **
            "compute.instances.get",
            "compute.instances.list",
            "compute.instances.getGuestAttributes"
        ],
    });

    new gcp.storage.BucketIAMBinding(`${opts.labName}-k8s-bucket-binding`, {
        bucket: configBucket.id,
        role: k8sRole.id,
        members: [pulumi.interpolate `serviceAccount:${k8sSa.email}`],
    })

    new gcp.projects.IAMBinding(`${opts.labName}-k8s-binding`, {
        role: k8sRole.id,
        members: [pulumi.interpolate `serviceAccount:${k8sSa.email}`],
        project: gcp.config.project!,
    })

    
    const k8sCpUserData = Mustache.render(fs.readFileSync("./config/K8S/userData/k8s.sh",{encoding:"utf-8"}),{
    K8S_VERSION: opts.k8s_version || "1.35",
    ETCD_VERSION: opts.etcd_version || "3.6.6",
    CILIUM_VERSION: opts.cilium_version || "1.18.3",
    K8S_ROLE: "cp",
    CLUSTER_READY: opts.clusterReady
    })
    const clusterCP = VMSLab({
        labName:opts.labName, 
        vmType: opts.vmType || "e2-medium",
        vmNum: opts.clustersNum, 
        vmId: `k8s-cp`,
        public: !opts.bastion ,
        ...opts.bastion ? {
            publiclyOpenedFwPorts: ["22", "6443"]
        }:{},
        userData: k8sCpUserData,
        region: opts.region,
        pubKey: opts.pubKey,
        vpc: vpc,
        sa: k8sSa,
        subnets: subnets.slice(1),
        extraMetada: {
            "enable-guest-attributes": "TRUE",
            'config-bucket': configBucket.name
        }
    })

    clusterCP.forEach((cp,i) => {
        new WaitForGuestOSCondition(`wait-for-${opts.labName}-k8s-cp-${i}`, {
            project: gcp.config.project!,
            zone: cp.zone,
            vmName: cp.name,
            expectedValue: 'completed',
            queryPath: 'status/startup',
            credentials: gcp.config.credentials,
        }, {
            dependsOn: cp
        });
        const k8sWkUserData = Mustache.render(fs.readFileSync("./config/K8S/userData/k8s.sh",{encoding:"utf-8"}),{
            K8S_VERSION: opts.k8s_version || "1.35",
            ETCD_VERSION: opts.etcd_version || "3.6.6",
            CILIUM_VERSION: opts.cilium_version || "1.18.3",
            K8S_ROLE: "wk",
            CLUSTER_READY: opts.clusterReady
        })
        const clusterWK = VMSLab({
            labName:opts.labName, 
            vmType: opts.vmType || "e2-medium",
            vmNum: opts.workersNum, 
            vmId: `k8s-${i}-wk`,
            public: !opts.bastion ,
            ...opts.bastion ? {
                publiclyOpenedFwPorts: ["22"]
            }:{},
            userData: k8sWkUserData,
            region: opts.region,
            pubKey: opts.pubKey,
            vpc: vpc,
            sa: k8sSa,
            subnets: subnets.slice(1),
            extraMetada: {
                "enable-guest-attributes": "TRUE",
                'config-bucket': configBucket.name,
                'cp' : cp.name
            }
        })

        clusterWK.forEach((wk,j) => {
            new WaitForGuestOSCondition(`wait-for-${opts.labName}-k8s-${i}-kw-${j}`, {
                project: gcp.config.project!,
                zone: wk.zone,
                vmName: wk.name,
                expectedValue: 'completed',
                queryPath: 'status/startup',
                credentials: gcp.config.credentials,
            }, {
                dependsOn: wk
            });
        })
        ret["clusters"] = [...ret["clusters"], {'cp': [clusterCP[i]], 'wks': clusterWK} ]
    })

    new gcp.compute.Firewall(`${opts.labName}-k8s-FW-rule`, {
        name: `${opts.labName}-k8s-fw-rule`,
        network: vpc.id,
        description: `All traffic is allowed among k8s nodes (and bastion)`,
        allows: [{
            protocol: "all"
        }],
        sourceServiceAccounts: [k8sSa.email, ...bastionSa ? [bastionSa.email] : []],
        targetServiceAccounts: [k8sSa.email, ...bastionSa ? [bastionSa.email] : []],
    })

    return ret;
}