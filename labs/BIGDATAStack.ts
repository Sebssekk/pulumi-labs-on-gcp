import * as gcp from "@pulumi/gcp";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { name } from "mustache";
import { access } from "node:fs";

export const BIGDATALab = (opts : { 
    labName : string,
    region: string,
    studentAccessNum: number ,
    accessPsw: string,
}) => {

// *** BIGDATA INFO ***
// *** REMEMBER to adjust also in // check in ../config/BIGDATA/bigdata.yaml
const JDKVersion = "21"
const PYVersion = "3.12"
const HIVEVersion = "4.2.0"
const HADOOPVersion = "3.4.2" 
const hiveUrl = `https://dlcdn.apache.org/hive/hive-${HIVEVersion}/apache-hive-${HIVEVersion}-bin.tar.gz`
const SPARKVersion = "4.1.0"
const HBASEVersion = "2.6.4"
/* ######################### THE GKE CLUSTER ################################### 
   #############################################################################
*/ 
    const bdSa = new gcp.serviceaccount.Account(`${opts.labName}-cluster-sa`, {
        accountId: `${opts.labName}-cluster-sa`,
        displayName: `Service Account for ${opts.labName} GKE cluster`,
    });

    new gcp.projects.IAMBinding(`${opts.labName}-bdNode-binding-a`, {
            role: "roles/container.defaultNodeServiceAgent",
            members: [pulumi.interpolate `serviceAccount:${bdSa.email}`],
            project: gcp.config.project!,
        })
    new gcp.projects.IAMBinding(`${opts.labName}-bdNode-binding-b`, {
            role: "roles/container.defaultNodeServiceAccount",
            members: [pulumi.interpolate `serviceAccount:${bdSa.email}`],
            project: gcp.config.project!,
        })

    new gcp.projects.Service("enable-filestore-api", {
        service: "file.googleapis.com",
        disableOnDestroy: false,
    });
    const bdCluster = new gcp.container.Cluster(`${opts.labName}-bd-cluster`, {
        deletionProtection: false,
        name: `${opts.labName}-bd-cluster`,
        location: `${opts.region}-a`,
        //removeDefaultNodePool: true,
        initialNodeCount: 1,
        nodeConfig: {
            machineType: "e2-standard-2",
            diskSizeGb: 20,
            serviceAccount: bdSa.email,
        },
        gatewayApiConfig: {
            channel: "CHANNEL_STANDARD"
        },
        addonsConfig: {
            gcpFilestoreCsiDriverConfig: {
                enabled: true
            }
        }
    });
    new gcp.container.NodePool(`${opts.labName}-access-nodepool`, {
        name: `${opts.labName}-access-nodepool`,
        location: `${opts.region}-a`,
        cluster: bdCluster.name,
        nodeCount: Math.floor(opts.studentAccessNum/3) +1,
        nodeConfig: {
            machineType: "e2-standard-4",
            diskSizeGb: 50,
            serviceAccount: bdSa.email,
            oauthScopes: ["https://www.googleapis.com/auth/cloud-platform"],
            labels: {
                stack: "access"
            },
            taints: [{
                key: "stack",
                value: "access",
                effect: "NO_SCHEDULE"
            }]
        },
    });

    new gcp.container.NodePool(`${opts.labName}-bigdata-nodepool`, {
        name: `${opts.labName}-bigdata-nodepool`,
        location: `${opts.region}-a`,
        cluster: bdCluster.name,
        nodeCount: 5,
        nodeConfig: {
            machineType: "e2-standard-4",
            diskSizeGb: 30,
            serviceAccount: bdSa.email,
            oauthScopes: ["https://www.googleapis.com/auth/cloud-platform"],
            labels: {
                stack: "bigdata"
            },
            taints: [{
                key: "stack",
                value: "bigdata",
                effect: "NO_SCHEDULE"
            }]
        },
    });

    const bootstrapAccessToken = gcp.organizations.getClientConfigOutput();

    const kubeconfig = pulumi.all([bdCluster.endpoint, bdCluster.masterAuth, bootstrapAccessToken.accessToken])
        .apply(([endpoint, masterAuth, token]) => {
        return `apiVersion: v1
clusters:
- cluster:
    certificate-authority-data: ${masterAuth.clusterCaCertificate}
    server: https://${endpoint}
  name: bd-gke-cluster
contexts:
- context:
    cluster: bd-gke-cluster
    user: gke-user
  name: bd-gke-context
current-context: bd-gke-context
kind: Config
users:
- name: gke-user
  user:
    token: ${token}
`;
    });

    const k8sProvider = new k8s.Provider("k8s-provider", { 
        kubeconfig: kubeconfig 
    });

/* ######################### BIGDATA STACK ################################### 
   ##########################################################################
*/
    const bigdataStack = new k8s.kustomize.v2.Directory("bigdata-yaml",{
       directory: "./config/BIGDATA/kustomize",
    }, {provider: k8sProvider})

/* ######################### ACCESS STACK ################################### 
   ##########################################################################
*/     
    const bootstrapConfig = new k8s.core.v1.ConfigMap("bootstrap-config", {
        metadata: {
            name: "bootstrap-config",
        },
        data: {
            "bootstrap.sh": `#!/bin/bash
echo ${opts.accessPsw} | sudo -S apt update
echo ${opts.accessPsw} | sudo -S apt -y install python${PYVersion} python3-pip wget openjdk-${JDKVersion}-jdk 
code-server --install-extension ms-python.python
code-server --install-extension ms-toolsai.jupyter
python3 -m pip config set global.break-system-packages true
pip install ipykernel jupyter pyspark==${SPARKVersion}
export PATH=$PATH:/opt/hadoop/bin
echo 'export PATH=$PATH:/opt/hadoop/bin' >> $HOME/.bashrc
export JAVA_HOME=/usr/lib/jvm/java-${JDKVersion}-openjdk-amd64
echo 'export JAVA_HOME=/usr/lib/jvm/java-${JDKVersion}-openjdk-amd64' >> $HOME/.bashrc
cd /opt
echo ${opts.accessPsw} | sudo -S wget ${hiveUrl}
echo ${opts.accessPsw} | sudo -S tar -xzvf ${hiveUrl.split('/').slice(-1)[0]}
echo ${opts.accessPsw} | sudo -S rm ${hiveUrl.split('/').slice(-1)[0]}
echo ${opts.accessPsw} | sudo -S mv ${hiveUrl.split('/').slice(-1)[0].split('.tar')[0]} hive
export PATH=$PATH:/opt/hive/bin
echo 'export PATH=$PATH:/opt/hive/bin' >> $HOME/.bashrc
mkdir -p /config/.local/lib/python${PYVersion}/site-packages/pyspark/conf
cp /opt/spark/conf/* /config/.local/lib/python${PYVersion}/site-packages/pyspark/conf
export PATH=$PATH:/config/.local/bin
echo 'export PATH=$PATH:/config/.local/bin' >> $HOME/.bashrc
export PATH=$PATH:/opt/hbase/bin
echo 'export PATH=$PATH:/opt/hbase/bin' >> $HOME/.bashrc
`
        }
    },{provider: k8sProvider})

    const accessService = new k8s.core.v1.Service("user-access-ss-svc", {
        metadata: {
            name: "user-svc",
        },
        spec: {
            clusterIP: "None",
            ports: [{
                name: "code",
                port: 8443,
                targetPort: 8443,
                protocol: "TCP",
            },
            {
                name: "chrome",
                port: 3001,
                targetPort: 3001,
                protocol: "TCP",
            },
            {
                name: "spark-client",
                port: 4040,
                targetPort: 4040,
                protocol: "TCP",
            }
            ],
            selector: {
                access: "user"
            }
        }
    },{provider: k8sProvider})

    new k8s.core.v1.PersistentVolumeClaim("shared", {
        metadata: {
            name: "shared",
        },
        spec: {
            accessModes: ["ReadWriteMany"],
            storageClassName: "standard-rwx",
            resources: {
                requests: {
                    storage: "5Gi"
                }
            }
        }
    },{provider: k8sProvider})

    new k8s.apps.v1.StatefulSet("user-access-ss", {
        metadata: {
            name: "user",
        },
        spec: {
            serviceName: accessService.metadata.name,
            selector: { matchLabels: {access: "user"}  },
            replicas: opts.studentAccessNum +1,
            template: {
                metadata: { labels:  {access: "user"} },
                spec: {
                    tolerations: [{
                        key: "stack",
                        operator: "Equal",
                        value: "access",
                        effect: "NoSchedule"
                    }],
                    affinity: {
                        nodeAffinity: {
                            preferredDuringSchedulingIgnoredDuringExecution: [{
                                weight: 100,
                                preference: {
                                    matchExpressions: [{
                                        key: "stack",
                                        operator: "In",
                                        values: ["access"]
                                    }]
                                }
                            }]
                        }
                    },
                    initContainers:[
                    {
                        name: "hadoop-init",
                        image: `apache/hadoop:${HADOOPVersion}`,
                        securityContext: {
                            runAsUser: 0
                        },
                        envFrom:[
                        {
                            configMapRef: {
                                name: "hadoop-config"
                            }
                        }],
                        args:[ "cp", "-a","/opt/hadoop/.", "/hadoop-conf"],
                        volumeMounts:[{
                          name: "opt-hadoop",
                          mountPath: "/hadoop-conf",
                        }],
                    },{
                        name: "hbase-init",
                        image: `sebssekk/hbase:${HBASEVersion}`,
                        securityContext: {
                            runAsUser: 0
                        },
                        envFrom:[{
                            configMapRef: { name: "hbase-config"}
                        }],
                        command:["/bin/bash", "-c","/entrypoint.sh || cp -a /opt/hbase/. /hbase-conf"],
                        volumeMounts:[{
                            name: "opt-hbase",
                            mountPath: "/hbase-conf",
                        }]
                    }],
                    containers: [{
                        name: "code-server",
                        image: "lscr.io/linuxserver/code-server:latest",
                        lifecycle: {
                            postStart: {
                                exec: {
                                    command: ["/bootstrap.sh"]
                                },
                            }
                        },
                        ports: [
                            { containerPort: 8443, name: "web" },
                            { containerPort: 4040, name: "spark-client" },
                        ],
                        resources: {
                            requests: {
                                memory: "1.5Gi",
                                cpu: "0.25"
                            },
                            limits: {
                                memory: "2Gi",
                                cpu: "1"
                            }
                        },
                        env: [
                            {
                                name: "PUID",
                                value: "1000"
                            },
                            {
                                name: "PGID",
                                value: "1000",
                            },
                            {
                                name: "TZ",
                                value: "Europe/Rome",
                            },
                            {
                                name: "PASSWORD",
                                value: opts.accessPsw,
                            },
                            {
                                name: "SUDO_PASSWORD",
                                value: opts.accessPsw,
                            }
                        ],
                        volumeMounts: [
                            {
                                name: "workspace",
                                mountPath: "/config/workspace/user-data"
                            },
                            {
                                name: "shared",
                                mountPath: "/config/workspace/shared-data"
                            },
                            {
                                name: "startup-config",
                                mountPath: "/bootstrap.sh",
                                subPath: "bootstrap.sh",
                            },
                            {
                                name: "opt-hadoop",
                                mountPath: "/opt/hadoop"
                            },
                            {
                                name: "spark-config",
                                mountPath: "/opt/spark/conf"
                            },
                            {
                                name: "opt-hbase",
                                mountPath: "/opt/hbase"
                            }
                        ]
                    },{
                        name: "chrome",
                        image: "lscr.io/linuxserver/chromium:latest",
                        ports: [{
                            containerPort: 3001,
                            name: "https"
                        }],
                        env: [
                            {
                                name: "PUID",
                                value: "1000"
                            },
                            {
                                name: "PGID",
                                value: "1000",
                            },
                            {
                                name: "TZ",
                                value: "Europe/Rome",
                            },
                        ],
                        resources: {
                            requests: {
                                memory: "512Mi",
                                cpu: "0.25"
                            },
                            limits: {
                                memory: "2Gi",
                                cpu: "2"
                            }
                        },
                        volumeMounts: [
                            {
                                name: "shared",
                                mountPath: "/shared"
                            },
                        ]
                    }
                    ],
                    volumes: [
                        {
                            name: "shared",
                            persistentVolumeClaim: {
                                claimName: "shared"
                            }
                        },
                        {
                            name: "startup-config",
                            configMap: {
                                name: bootstrapConfig.metadata.name,
                                defaultMode: 0o555
                            }
                        },
                        {
                            name: "opt-hadoop",
                            emptyDir: {}
                        },
                        {
                            name: "spark-config",
                            configMap: {
                                name: "spark-config"
                            }
                        },
                        {
                            name: "opt-hbase",
                            emptyDir: {}
                        }
                    ]
                },
            },
            volumeClaimTemplates: [{
                metadata: {
                    name: "workspace",
                    
                },
                spec: {
                    accessModes: ["ReadWriteOnce"],
                    storageClassName: "standard-rwo",
                    resources: {
                        requests: {
                            storage: "1Gi"
                        }
                    }
                }
            }]
        },
    }, {provider: k8sProvider, dependsOn: [bigdataStack]})

    const ret : {kubeconfig: pulumi.Output<string>, accessIPs: pulumi.Output<string>[]} = {
        kubeconfig: kubeconfig,
        accessIPs : []
    }

    Array.from(new Array(opts.studentAccessNum +1)).forEach((_,i) => {
        const externalAccess = new k8s.core.v1.Service(`user-access-svc-${i}`, {
            metadata: {
                name: `user-${i}`,
                
            },
            spec: {
                type: "LoadBalancer",
                ports: [{
                    name: "code",
                    port: 8080,
                    targetPort: 8443,
                    protocol: "TCP",
                },
                {
                    name: "chrome",
                    port: 443,
                    targetPort: 3001,
                    protocol: "TCP",
                }
                ],
                selector: {
                    "statefulset.kubernetes.io/pod-name": `user-${i}`
                }
            }
        },{provider: k8sProvider})

        ret.accessIPs.push(externalAccess.status.apply(s => s.loadBalancer.ingress[0].ip))
    })

    return ret
}