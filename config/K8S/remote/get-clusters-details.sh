#!/bin/bash
set -x 
INSTANCES=$(gcloud compute instances list --filter="name ~ ${LAB_NAME}-k8s" --format="value(name)")

echo "Waiting for the following VMs to complete startup: "
echo "$INSTANCES"
echo "--------------------------------------------------"

# 2. Loop until the list of "incomplete" VMs is empty
while true; do
    all_finished=true
    
    for vm in $INSTANCES; do
        zone=$(gcloud compute instances list --filter="name=$vm" --format="value(zone.scope())")
        vmlink=$(gcloud compute instances describe $vm --zone $zone    --format="value(selfLink)")
        status=$(gcloud compute instances get-guest-attributes "$vmlink"  --query-path=status/startup   --format="value(value)" 2>/dev/null)

        if [[ "$status" == "completed" ]]; then
            echo "✅ $vm: Complete"
        else
            echo "⏳ $vm: Still initializing..."
            all_finished=false
        fi
    done

    if [ "$all_finished" = true ]; then
        echo "--------------------------------------------------"
        echo "All VMs are ready!"
        break
    fi

    echo "Re-checking in 10 seconds..."
    sleep 10
done

echo "CP,Workers,User(s)" > /public/user-instances.csv

CPs=''
WKs=''

for x in $(seq 0 $(($CLUSTERS_NUM-1))); do
    user=''
    for access in $(seq 0 $(($ACCESS_NUM))); do
        if [[ $(($access % $CLUSTERS_NUM)) == $x ]]; then
            user=$user"user$access "
        fi
    done
    cp=$(gcloud compute instances list --filter="name ~ ${LAB_NAME}-k8s-cp-$x" --format="value(networkInterfaces[0].networkIP)")
    workers=$(gcloud compute instances list --filter="name ~ ${LAB_NAME}-k8s-$x-wk" --format="value(networkInterfaces[0].networkIP)")
    echo "$cp,$workers,$user" >> /public/user-instances.csv

    CPs="${CPs}m$x  ansible_host=${cp}\n"

    worker_num=1
    for worker in $workers; do
        WKs="${WKs}w$x-$worker_num  ansible_host=$worker\n"
        worker_num=$((worker_num+1))
    done
done

pip install ansible

sudo mkdir -p /etc/ansible

echo -e "[cps]\n$CPs\n[workers]\n$WKs\n[all:vars]\nansible_user=ubuntu\n" | sudo tee /etc/ansible/inventory.ini 

sudo chmod +r /etc/ansible/*

sudo tee /home/$OS_USERNAME/.ansible.cfg << EOF
[defaults]
host_key_checking = False
interpreter_python=auto_silent  
inventory = /etc/ansible/inventory.ini
EOF

sudo chown $OS_USERNAME:$OS_USERNAME /home/$OS_USERNAME/.ansible.cfg

#echo "vm-name,private-ip,machine-id,region,zone,instance-type" > /public/k8s-instances.csv
#
#aws ec2 describe-instances --filters "Name=instance-state-name,Values=running" "Name=tag:Name,Values=k8s*" --query "Reservations[].Instances[].[Tags[?Key=='Name'].Value|[0],PrivateIpAddress,InstanceId,Placement.AvailabilityZone,InstanceType]" --output text | while read -r name ip id zone type; do
#    region=${zone%?}
#    echo "$name,$ip,$id,$region,$zone,$type" >> /public/k8s-instances.csv
#done
