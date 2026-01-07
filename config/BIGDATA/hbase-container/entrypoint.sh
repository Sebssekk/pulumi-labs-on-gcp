#!/bin/bash
set -e

# Path to HBase config
CONF_FILE="$HBASE_HOME/conf/hbase-site.xml"

# Start the XML file
echo '<?xml version="1.0"?>' > $CONF_FILE
echo '<?xml-stylesheet type="text/xsl" href="configuration.xsl"?>' >> $CONF_FILE
echo '<configuration>' >> $CONF_FILE

# Loop through env vars starting with HBASE_CONF_
# Format: HBASE_CONF_hbase_rootdir=hdfs://... -> <property><name>hbase.rootdir</name><value>hdfs://...</value></property>
for var in $(env | grep '^HBASE_CONF_'); do
  key=$(echo "$var" | sed -r 's/^HBASE_CONF_([^=]+)=.*/\1/' | sed 's/_/./g')
  value=$(echo "$var" | sed -r 's/^HBASE_CONF_[^=]+=(.*)/\1/')
  
  echo "  <property>" >> $CONF_FILE
  echo "    <name>$key</name>" >> $CONF_FILE
  echo "    <value>$value</value>" >> $CONF_FILE
  echo "  </property>" >> $CONF_FILE
done

echo '</configuration>' >> $CONF_FILE

# Determine which service to start based on the COMPONENT env var
if [ "$COMPONENT" == "master" ]; then
  echo "Starting HBase Master..."
 # exec hbase thrift start & 
  exec hbase master start
elif [ "$COMPONENT" == "regionserver" ]; then
  echo "Starting HBase RegionServer..."
  exec hbase regionserver start
else
  echo "Error: COMPONENT env var must be 'master' or 'regionserver'."
  exit 1
fi