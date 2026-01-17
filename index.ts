import * as pulumi from "@pulumi/pulumi";
import { LabType } from "./types";
import {VMSLab} from "./labs/VMStack";
import {K8SLab} from "./labs/K8SStack";
import { BIGDATALab } from "./labs/BIGDATAStack";
import ssh from 'micro-key-producer/ssh.js';
import { randomBytes } from 'micro-key-producer/utils.js';
import * as fs from "node:fs"
import * as Mustache from "mustache"

const config = new pulumi.Config();

const region = process.env.GCPregion || config.get("GCPregion") || "us-central1";

const labType: keyof typeof LabType =  config.require("labType");

const labName : string =  process.env.labName || config.get("labName") || pulumi.getStack()

let out : pulumi.Output<any> = pulumi.output({});
let info : string = "";

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

const sshKeyOut = pulumi.output({
    'ssh-key' : privateKey
})

switch (LabType[labType]){

    case LabType.VM:
        const vmNum : number = parseInt(process.env.vmNum || "") || config.getNumber("vmNum") || 1 ; 
        const userData : string = process.env.userData || config.get("userData") || '';
        const publiclyOpenedFwPorts : number[] = process.env.publiclyOpenedFwPorts?.split(',').map(p => parseInt(p)).filter(p=>!isNaN(p)) || config.getObject("publiclyOpenedFwPorts") || [22,80,443];
        const image : string = process.env.image || config.get("image") || "ubuntu-2204-lts";
        const extraMetada : any = (() => { try {JSON.parse(process.env.extraMetada || '');} catch {return undefined}})() || config.getObject("extraMetada") || "{}";
        const vmOsUsername: string = process.env.osUsername || config.get("osUsername") || "ubuntu";
        const vmVmType : string =  process.env.vmType || config.get("vmType") || "e2-medium";
        const diskSize : number =  parseInt(process.env.diskSize || "") || config.getNumber("diskSize") || 20;
        const nestedVirtualization : boolean =  (process.env.nestedVirtualization?.toLowerCase() === 'true' || process.env.nestedVirtualization?.toLowerCase() === "yes") || config.getBoolean("nestedVirtualization") || false;
        
        const vms = VMSLab({
            labName:labName, 
            vmType: vmVmType,
            vmNum: vmNum, 
            vmId: "vm" , 
            public: true,
            userData: userData,
            // TO GET USERDATA LOG
            // sudo journalctl -u google-startup-scripts.service
            region: region,
            pubKey: publicKey,
            publiclyOpenedFwPorts : publiclyOpenedFwPorts.map(p => p.toString()),
            image: image,
            diskSize: diskSize,
            osUsername: vmOsUsername,
            extraMetada: JSON.parse(extraMetada),
            nestedVirtualization
        })
        
        out = pulumi.all([...vms]).apply(vms => 
            {
                return [ ...vms.map((vm,i) => ({ 
                    [`VM${i}`] : { 
                        "name": vm.name,
                        "publicIP":vm.networkInterfaces[0].accessConfigs?.apply(ac => ac ? ac.map(ac => ac.natIp ): []),
                        "privateIP": vm.networkInterfaces[0].networkIp
                    }})), sshKeyOut]
            }) 
        break;


    case LabType.K8S:
        const bastion : boolean = (process.env.bastion?.toLowerCase() === 'true' || process.env.bastion?.toLowerCase() === "yes") || config.getBoolean("bastion") || true;
        const k8sStudentAccessNum : number = parseInt(process.env.studentAccessNum || '') || config.getNumber("studentAccessNum") || 0;
        const clustersNum : number = parseInt(process.env.clustersNum || '') || config.getNumber("clustersNum") || k8sStudentAccessNum + 1;
        const workersNum : number = parseInt(process.env.workersNum || '') || config.getNumber("workersNum") || 1;
        const clusterReady: boolean = (process.env.clusterReady?.toLowerCase() === 'true' || process.env.clusterReady?.toLowerCase() === "yes") || config.getBoolean("clusterReady") || false;
        const k8sVersion: string =  process.env.k8sVersion || config.get("k8sVersion") || "1.35";
        const k8sAccessPsw: string =  process.env.accessPsw || config.get("accessPsw") || "lab123";
        const etcdVersion: string =  process.env.etcdVersion || config.get("etcdVersion") || "3.6.6";
        const ciliumVersion: string =  process.env.ciliumVersion || config.get("ciliumVersion") || "1.18.5";
        const k8sOsUsername: string = process.env.osUsername || config.get("osUsername") || "ubuntu";
        const k8sVmType : string =  process.env.vmType || config.get("vmType") || "e2-medium";
        const accessVmType : string =  process.env.accessVmType || config.get("accessVmType") || "e2-standard-4"
        
        const k8sVms = K8SLab({
            labName,
            bastion,
            studentAccessNum: k8sStudentAccessNum,
            clustersNum,
            workersNum, 
            region,
            pubKey:publicKey,
            privKey: privateKey,
            clusterReady,
            k8sVersion,
            accessPsw: k8sAccessPsw,
            etcdVersion,
            ciliumVersion,
            osUsername: k8sOsUsername,
            vmType: k8sVmType,
            accessVmType,
        });

        const accessOut = pulumi.all([...k8sVms.access ?[k8sVms.access] :[] ]).apply(vms => {
            info = Mustache.render(fs.readFileSync("./docs/K8S-README.md",{encoding:"utf-8"}),{
                publicIP :vms[0].networkInterfaces[0].accessConfigs?.apply(ac => ac ? ac.map(ac => ac.natIp ): [])[0],
                users : Array.from(new Array(k8sStudentAccessNum + 1)).map((_,i) => ({port: 8080 +i, name: `user${i}`}))
            })

            return vms.map((vm,i) => ({ 
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

        out = pulumi.all([clustersOut, bucketOut, accessOut, sshKeyOut])
        
        break;
    case LabType.BIGDATA:
        
        const bdStudentAccessNum : number = parseInt(process.env.studentAccessNum || '') || config.getNumber("studentAccessNum") || 0;
        const bdAccessPsw: string =  process.env.accessPsw || config.get("accessPsw") || "lab123";

        const bdOutput = BIGDATALab({
            labName,
            region,
            studentAccessNum: bdStudentAccessNum,
            accessPsw: bdAccessPsw,
        })

        out = pulumi.all([bdOutput])
        break;
    default:
        throw new Error("Invalid lab type");

}

export const output = out;

export const readme : pulumi.Output<string> = pulumi.output(info);
