import * as pulumi from "@pulumi/pulumi";
import { LabType } from "./types";
import {VMSLab} from "./labs/VMStack";
import {K8SLab} from "./labs/K8SStack";
import ssh from 'micro-key-producer/ssh.js';
import { randomBytes } from 'micro-key-producer/utils.js';
import * as fs from "node:fs"

const config = new pulumi.Config();

const labType: keyof typeof LabType = config.require("labType");
const labName : string = config.require("labName")
const region = config.get("region") || "us-central1";


let out : pulumi.Output<any> = pulumi.output({});

let privateKey: string;
let publicKey: string;
if (fs.existsSync("key.pem") && fs.existsSync("key.pub")) {
    privateKey = fs.readFileSync("key.pem", "utf-8");
    publicKey = fs.readFileSync("key.pub", "utf-8");
} else {
    const seed = randomBytes(32);
    ({privateKey, publicKey} = ssh(seed, 'ubuntu@gcp'));
    fs.writeFileSync("key.pem", privateKey);
    fs.writeFileSync("key.pub", publicKey);
}

switch (LabType[labType]){
    
    case LabType.VM:
        const vmNum : number = config.requireNumber("vmNum");
       
        const vms = VMSLab({
            labName:labName, 
            vmType: config.get("vmType") || "e2-medium",
            vmNum: vmNum, 
            vmId: "vm" , 
            public: true,
            userData: config.get("userData") || '',
            // TO GET USERDATA LOG
            // sudo journalctl -u google-startup-scripts.service
            region: region,
            pubKey: publicKey,
            publiclyOpenedFwPorts : config.get("publiclyOpenedFwPorts")?.split(',') || undefined,
            image: config.get("publiclyOpenedFwPorts") || undefined,
            osUsername: config.get("osUsername") || undefined,
            extraMetada: config.get("extraMetada") || undefined,
        })
        
        out = pulumi.all([...vms]).apply(vms => 
            {
                return vms.map((vm,i) => ({ 
                   // 'ssh-key' : privateKey,
                    [`VM${i}`] : { 
                        "name": vm.name,
                        "publicIP":vm.networkInterfaces[0].accessConfigs?.apply(ac => ac ? ac.map(ac => ac.natIp ): []),
                        "privateIP": vm.networkInterfaces[0].networkIp
                    }}))
            }) 
        break;


    case LabType.K8S:
        const bastion : boolean = config.getBoolean("bastion") || true;
        const accessNum : number = config.requireNumber("accessNum");
        const clustersNum : number = config.getNumber("clustersNum") || accessNum + 1;
        const workersNum : number = config.getNumber("workersNum") || 1;
        
        const k8sVms = K8SLab({
            labName,
            bastion,
            accessNum,
            clustersNum,
            workersNum, 
            region,
            pubKey:publicKey,
            privKey: privateKey,
            clusterReady: config.getBoolean("clusterReady") || false,
            k8s_version: config.get("k8s_version") || "1.35",
            accessPsw: config.get("accessPsw") || "lab123",
            etcd_version: config.get("etcd_version") || undefined,
            cilium_version: config.get("cilium_version") || undefined,
            osUsername: config.get("osUsername") || undefined,
            vmType: config.get("vmType") || undefined,
        });

        const accessOut = pulumi.all([...k8sVms.access ?[k8sVms.access] :[] ]).apply(vms => {
            return vms.map((vm,i) => ({ 
               // 'ssh-key' : privateKey,
                [`AccessVM${i}`] : { 
                    "publicIP":vm.networkInterfaces[0].accessConfigs?.apply(ac => ac ? ac.map(ac => ac.natIp ): [])
                }
            }))
        })
        const bucketOut = pulumi.all([ k8sVms["config-bucket"] ]).apply(buckets => {
            return buckets.map((b) => ({ 
               // 'ssh-key' : privateKey,
                [`ConfigBucket`] : { 
                    "name": b!.name
                }
            }))
        })

        const clustersOut = pulumi.all(k8sVms.clusters).apply(clusters => {
            return clusters.map((c,i) => ({
                [`Cluster${i}`] : {
                    'cp': c.cp.map(cp => bastion? cp.networkInterfaces[0].networkIp : 
                        cp.networkInterfaces[0].accessConfigs?.apply(ac => ac ? ac.map(ac => ac.natIp ): [])),
                    'wks': c.wks.map(wk => bastion? wk.networkInterfaces[0].networkIp : 
                        wk.networkInterfaces[0].accessConfigs?.apply(ac => ac ? ac.map(ac => ac.natIp ): [])),
                }
             }))
        })

        out = pulumi.all([clustersOut, bucketOut, accessOut, ])
        
        break;
    case LabType.BIGDATA:
        break;
    default:
        throw new Error("Invalid lab type");

}

export const output = out;
