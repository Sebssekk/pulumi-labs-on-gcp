#!/bin/bash
set -x

## Get the PSW
sudo mkdir -p /tmp
ACCESS_PSW={{ACCESS_PSW}}


## Install Deps
sudo apt-get update
sudo apt-get -y install apt-transport-https ca-certificates gnupg curl git python3-pip

## Install GCLOUD CLI
curl https://packages.cloud.google.com/apt/doc/apt-key.gpg | sudo gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg
echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" | sudo tee -a /etc/apt/sources.list.d/google-cloud-sdk.list
sudo apt-get update && sudo apt-get install -y google-cloud-cli

sudo mkdir -p /public
sudo chmod 777 /public

## Get and place remote config
BUCKET_NAME=$(curl -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/attributes/config-bucket)
sudo gcloud storage cp gs://$BUCKET_NAME/* /tmp --recursive
sudo mv /tmp/key.pem /public/key.pem
sudo chmod 777 /public/key.pem
sudo mv /tmp/setup-cert.sh /opt/setup-cert.sh
sudo chmod u+x /opt/setup-cert.sh
sudo mv /tmp/get-clusters-details.sh /opt/get-clusters-details.sh
sudo chmod u+x /opt/get-clusters-details.sh
sudo mv /tmp/cert-setup.service /etc/systemd/system/cert-setup.service
sudo sed -i "s/-PSW-/$ACCESS_PSW/" /tmp/code-server@.service 
sudo mv /tmp/code-server@.service /etc/systemd/system/mycode-server@.service
sudo systemctl daemon-reload

## Cert Generation Service
sudo systemctl enable --now cert-setup.service

## Install Docker
sudo curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
sudo sh /tmp/get-docker.sh
sudo rm /tmp/get-docker.sh
sudo usermod -aG docker {{OS_USERNAME}}

## Install Kubernetes utilities
### Kubectl
K8S_VERSION=v{{K8S_VERSION}}
curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.35/deb/Release.key | sudo gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg
sudo chmod 644 /etc/apt/keyrings/kubernetes-apt-keyring.gpg
echo "deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/$K8S_VERSION/deb/ /" | sudo tee /etc/apt/sources.list.d/kubernetes.list
sudo chmod 644 /etc/apt/sources.list.d/kubernetes.list 
sudo apt-get update
sudo apt-get install -y kubectl
### Helm
sudo curl -fsSL -o /tmp/get_helm.sh https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3
sudo chmod 700 /tmp/get_helm.sh
sudo /tmp/get_helm.sh
sudo rm /tmp/get_helm.sh

## Code Server
curl -fsSL https://code-server.dev/install.sh | sudo sh

## Cluster details
LAB_NAME={{LAB_NAME}} ACCESS_NUM={{ACCESS_NUM}} CLUSTERS_NUM={{CLUSTERS_NUM}} OS_USERNAME={{OS_USERNAME}} sudo -E /opt/get-clusters-details.sh 

## Per user config
ACCESS_NUM={{ACCESS_NUM}}
users=()
for x in $(seq 1 $ACCESS_NUM); do 
    useradd user$x --create-home -s /bin/bash 
    echo -e "$ACCESS_PSW\n$ACCESS_PSW" | sudo passwd user$x 
    users+=("user$x")
done

users+=("{{OS_USERNAME}}")

for user in "${users[@]}"; do 
    sudo usermod -a -G docker $user
    sudo su $user -c "echo -e 'source <(kubectl completion bash) \nalias k=kubectl \ncomplete -o default -F __start_kubectl k' >> /home/$user/.bashrc"
    sudo su $user -c "mkdir -p /home/$user/.ssh"
    sudo cp /public/key.pem /home/$user/.ssh/k8s-key && sudo chmod 600 /home/$user/.ssh/k8s-key
    sudo chown $user:$user /home/$user/.ssh/k8s-key
    echo 'eval $(ssh-agent -s)' | sudo tee -a /home/$user/.bashrc
    echo "ssh-add /home/$user/.ssh/k8s-key" | sudo tee -a /home/$user/.bashrc
    sudo systemctl enable --now mycode-server@$user.service
    sudo su $user -c "code-server --install-extension ms-kubernetes-tools.vscode-kubernetes-tools"
    sudo su $user -c "mkdir -p /home/$user/.kube"
{{#CLUSTER_READY}}
    if [[ $user == "{{OS_USERNAME}}" ]]; then 
        CP_IP=$(awk -F',' -v user="user0" '$3 ~ "(^|[[:space:]]?)"user"([[:space:]]|$)" { print $1 }' /public/user-instances.csv)
    else
        CP_IP=$(awk -F',' -v user="$user" '$3 ~ "(^|[[:space:]]?)"user"([[:space:]]|$)" { print $1 }' /public/user-instances.csv)
    fi
    sudo su $user -c "scp -o 'StrictHostKeyChecking no' -i /home/$user/.ssh/k8s-key ubuntu@${CP_IP}:/home/ubuntu/.kube/config /home/$user/.kube/config"
{{/CLUSTER_READY}}
done

## Signal Startup completed

curl -X PUT -H "Metadata-Flavor: Google" \
--data "completed" \
http://metadata.google.internal/computeMetadata/v1/instance/guest-attributes/status/startup
