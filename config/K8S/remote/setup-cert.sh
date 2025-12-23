#!/bin/bash
# Exit immediately if a command exits with a non-zero status.
set -ex

# --- 1. Fetch Dynamic Metadata ---
# Get the current public IP address
IP=$(curl -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip)

if [ -z "$IP" ]; then
    echo "Error: Could not retrieve public IP."
    exit 1
fi

# Define output paths
PUBLIC_DIR="/public"
KEY_PATH="$PUBLIC_DIR/code.key"
CRT_PATH="$PUBLIC_DIR/code.crt"


# --- 2. Create the Public Directory (if needed) ---
if [ ! -d "$PUBLIC_DIR" ]; then
    sudo mkdir -p "$PUBLIC_DIR"
    sudo chmod 777 "$PUBLIC_DIR"
else
    echo "Public directory already exists."
fi

# --- 3. Generate Certificate and Key ---
echo "Generating self-signed certificate for IP: $IP ..."

# Generate the self-signed certificate using the fetched data
openssl req -x509 -newkey rsa:4096 -days 365 -nodes \
-keyout "$KEY_PATH" -out "$CRT_PATH" \
-subj "/C=US/ST=SomeState/L=SomeCity/O=MyOrganization/OU=MyUnit/CN=ip-$(echo $IP | tr '.' '-')" \
-addext "subjectAltName=IP:$IP"

# --- 4. Set Permissions ---
echo "Setting permissions on certificate files..."
chmod 777 "$KEY_PATH" "$CRT_PATH"

echo "Certificate setup complete."