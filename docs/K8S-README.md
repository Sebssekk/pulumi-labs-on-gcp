# **Kubernetes Lab**
## **Access Info**
A bastion VM with a code-server is accessible at {{publicIp}}.  
A code-server instance has been created for each user (plus the teacher one)
{{#users}}
- {{name}} -> [https://{{publicIp}}:{{port}}](https://{{publicIp}}:{{port}})
{{/users}}