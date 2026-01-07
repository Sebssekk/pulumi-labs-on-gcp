FROM eclipse-temurin:21-jdk-jammy AS fetcher
ARG HBASE_VERSION=2.6.4
WORKDIR /tmp
RUN apt-get update && apt-get install -y wget \
    && wget https://downloads.apache.org/hbase/${HBASE_VERSION}/hbase-${HBASE_VERSION}-bin.tar.gz \
    && tar -xzf hbase-${HBASE_VERSION}-bin.tar.gz \
    && mv hbase-${HBASE_VERSION} /opt/hbase

FROM eclipse-temurin:21-jre-jammy
ENV HBASE_HOME=/opt/hbase \
    JAVA_HOME=/opt/java/openjdk \
    PATH=$PATH:/opt/hbase/bin

COPY --from=fetcher /opt/hbase /opt/hbase
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Important for Java 21 reflection
ENV HBASE_OPTS="--add-opens java.base/java.lang=ALL-UNNAMED --add-opens java.base/java.util=ALL-UNNAMED --add-opens java.base/java.nio=ALL-UNNAMED --add-opens java.base/sun.nio.ch=ALL-UNNAMED"

WORKDIR /opt/hbase
ENTRYPOINT ["/entrypoint.sh"]