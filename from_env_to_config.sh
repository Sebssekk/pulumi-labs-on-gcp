#!/bin/bash
echo "Pulumi converted environment variable:"
for e in  $(env | grep "^PULUMI_CFG_" | cut -d= -f1); do
  pulumi_cfg="${e#PULUMI_CFG_}"
  value="${!e}"  
  echo "[+] ${pulumi_cfg} = ${value}"
  pulumi config set ${pulumi_cfg} ${value}
done