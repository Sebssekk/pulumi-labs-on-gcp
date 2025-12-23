#!/bin/bash
set -x

## Install Deps
sudo apt-get update
sudo mkdir -p /tmp
sudo apt-get -y install apt-transport-https ca-certificates gnupg software-properties-common curl git  jq
sudo apt install -y python3-pip gnupg2

## Install GCLOUD CLI
curl https://packages.cloud.google.com/apt/doc/apt-key.gpg | sudo gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg
echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" | sudo tee -a /etc/apt/sources.list.d/google-cloud-sdk.list
sudo apt-get update && sudo apt-get install -y google-cloud-cli

## Kubernetes prep
K8S_VERSION=v{{K8S_VERSION}}
sudo apt-get -y update && sudo apt-get -y upgrade
sudo systemctl stop unattended-upgrades
sudo apt-get -y purge unattended-upgrades
                        
sudo swapoff -a && sudo sed -i '/ swap / s/^\\(.*\\)$/#\\1/g' /etc/fstab

sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmour -o /etc/apt/trusted.gpg.d/docker.gpg && sudo add-apt-repository "deb [arch=amd64] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" && sudo apt-get update
sudo apt-get install -y containerd.io
# containerd config default | sudo tee /etc/containerd/config.toml >/dev/null 2>&1
# sudo sed -i 's/SystemdCgroup \\= false/SystemdCgroup \\= true/g' /etc/containerd/config.toml
sudo systemctl enable containerd

sudo curl -fsSL https://pkgs.k8s.io/core:/stable:/$K8S_VERSION/deb/Release.key |  sudo gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg
echo "deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/$K8S_VERSION/deb/ /" | sudo  tee /etc/apt/sources.list.d/kubernetes.list
sudo apt-get update && sudo apt-get install -y kubelet kubeadm kubectl && sudo apt-mark hold kubelet kubeadm kubectl
# sudo sed -i s"/KUBELET_EXTRA_ARGS=/KUBELET_EXTRA_ARGS=\"--fail-swap-on=false\"/" /etc/default/kubelet
sudo systemctl enable kubelet

## CILIUM CLI INSTALL
CILIUM_CLI_VERSION=$(curl -s https://raw.githubusercontent.com/cilium/cilium-cli/main/stable.txt)
curl -L --fail --remote-name-all https://github.com/cilium/cilium-cli/releases/download/$CILIUM_CLI_VERSION/cilium-linux-amd64.tar.gz
sudo tar xzvfC cilium-linux-amd64.tar.gz /usr/local/bin
rm cilium-linux-amd64.tar.gz

## ETCD
ETCD_VERSION=v{{ETCD_VERSION}}

sudo curl -SLO https://github.com/etcd-io/etcd/releases/download/${ETCD_VERSION}/etcd-${ETCD_VERSION}-linux-amd64.tar.gz
sudo tar -xzvf etcd-${ETCD_VERSION}-linux-amd64.tar.gz
sudo cp etcd-${ETCD_VERSION}-linux-amd64/etcd* /usr/bin/
sudo rm etcd-${ETCD_VERSION}-linux-amd64.tar.gz
sudo rm -r etcd-${ETCD_VERSION}-linux-amd64

## Kernel prep
echo 1024 | sudo tee /sys/kernel/mm/hugepages/hugepages-2048kB/nr_hugepages
echo vm.nr_hugepages = 1024 | sudo tee -a /etc/sysctl.conf
cat <<EOF | sudo tee /etc/modules-load.d/k8s.conf
overlay
br_netfilter
nvme-tcp
EOF

sudo modprobe overlay
sudo modprobe br_netfilter
sudo modprobe nvme_tcp
cat <<EOF | sudo tee /etc/sysctl.d/k8s.conf
net.bridge.bridge-nf-call-iptables  = 1
net.bridge.bridge-nf-call-ip6tables = 1
net.ipv4.ip_forward                 = 1
EOF

sudo systemctl restart systemd-modules-load.service
sudo sysctl --system

sleep 5
sudo systemctl start containerd
sudo systemctl start kubelet

BUCKET_NAME=$(curl -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/attributes/config-bucket)

sudo gcloud storage cp gs://$BUCKET_NAME/key.pem /tmp/key
sudo chown ubuntu:ubuntu /tmp/key
sudo chmod 600 /tmp/key

sudo rm /etc/containerd/config.toml
sudo systemctl restart containerd

{{#CLUSTER_READY}}

## K8s initilize
ROLE={{K8S_ROLE}}

### MASTER INIT
CILIUM_VERSION={{CILIUM_VERSION}}
if [[ $ROLE == "cp" ]]; then
    sudo kubeadm init --pod-network-cidr 172.16.0.0/16
    sudo mkdir -p /home/ubuntu/.kube/
    sudo cp /etc/kubernetes/admin.conf /home/ubuntu/.kube/config
    sudo chown -R ubuntu:ubuntu /home/ubuntu/.kube
    sudo su ubuntu -c "cilium install --version $CILIUM_VERSION --set ipam.mode=kubernetes"
    sudo kubeadm token create --print-join-command | sudo tee /tmp/join.me
    sudo chown ubuntu:ubuntu /tmp/join.me
fi
if [[ $ROLE == "wk" ]]; then
    CP_VM=$(curl -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/attributes/cp)
    CP_IP=$(gcloud compute instances list --filter="name ~ $CP_VM" --format="value(networkInterfaces[0].networkIP)")
    while true; do
        zone=$(gcloud compute instances list --filter="name=$CP_VM" --format="value(zone.scope())")
        vmlink=$(gcloud compute instances describe $CP_VM --zone $zone    --format="value(selfLink)")
        status=$(gcloud compute instances get-guest-attributes "$vmlink"  --query-path=status/startup   --format="value(value)" 2>/dev/null)
        if [[ "$status" == "completed" ]]; then
            break
        fi
        sleep 10
    done
    sudo scp -o "StrictHostKeyChecking no" -i /tmp/key ubuntu@${CP_IP}:/tmp/join.me /tmp/join.me
    sudo chmod +x /tmp/join.me
    sudo /tmp/join.me
fi
{{/CLUSTER_READY}}

## Signal Startup completed

curl -X PUT -H "Metadata-Flavor: Google" \
--data "completed" \
http://metadata.google.internal/computeMetadata/v1/instance/guest-attributes/status/startup