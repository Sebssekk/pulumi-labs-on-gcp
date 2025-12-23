import * as pulumi from "@pulumi/pulumi";
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { InstancesClient } from "@google-cloud/compute";
import { GoogleAuth} from "google-auth-library";

type WaitForGuestOSProviderInputs = {
    project: string;
    zone: string;
    vmName: string;
    queryPath: string;
    expectedValue: string;
    errorValue?: string;
    credentials?: string;
};

// 1. Define the Dynamic Provider Logic
class WaitForGuestOSProvider implements pulumi.dynamic.ResourceProvider {
    async create(inputs: WaitForGuestOSProviderInputs): Promise<pulumi.dynamic.CreateResult> {
        const { project, zone, vmName, queryPath, expectedValue, errorValue, credentials } = inputs;
        
        let auth : GoogleAuth | undefined;
    
        if (credentials){
            try {
                const parsedCred = JSON.parse(credentials);
                // Credentials is the file content (JSON)
                auth = new GoogleAuth({
                    credentials: parsedCred,
                    scopes: 'https://www.googleapis.com/auth/cloud-platform'
                })                
            } catch (e) {
                // Use 'credentials' as a file path  
                //keyfile = credentials 
                auth = new GoogleAuth({
                    keyFilename: credentials,
                    scopes: 'https://www.googleapis.com/auth/cloud-platform'
                })
            }
        }
    
        const client = new InstancesClient({auth});


        console.log(`Polling ${vmName} for ${queryPath} to be ${expectedValue}`);

        while (true) {
            try {
                const [response] = await client.getGuestAttributes({
                    project,
                    zone,
                    instance: vmName,
                    queryPath: queryPath,
                });
                const key = queryPath.split('/').pop();
                const items = response.queryValue?.items || [];
                const actualValue = items.find(i => i.key === key)?.value;

                if (actualValue === expectedValue) {
                    break; 
                }
                if (actualValue && (actualValue === errorValue)) {
                    throw new Error(`${queryPath} == ${actualValue} for instance ${vmName}`)
                }
            } catch (err: any) {
                // 404 means the attribute isn't created yet; we just wait.
                if (err.code !== 404) throw err;
            }

            // Wait 10 seconds before polling again
            await new Promise(resolve => setTimeout(resolve, 10000));
        }

        return { id: `${vmName}-ready`, outs: { 'status': 'ready' } };
    }
}

// 2. Create a class for the Resource
export class WaitForGuestOSCondition extends pulumi.dynamic.Resource {
    constructor(name: string, args: { 
        project: pulumi.Input<string>, 
        zone: pulumi.Input<string>, 
        vmName: pulumi.Input<string>, 
        queryPath: pulumi.Input<string>, 
        expectedValue: pulumi.Input<string>, 
        errorValue?: pulumi.Input<string>, 
        credentials?: pulumi.Input<string>
    }, opts?: pulumi.CustomResourceOptions) {
        super(new WaitForGuestOSProvider(), name, args, opts);
    }
}