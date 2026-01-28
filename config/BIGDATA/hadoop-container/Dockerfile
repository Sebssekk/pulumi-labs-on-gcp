FROM apache/hadoop:3.4.2

USER root

# 1. Install Java 17 
RUN echo -e $"[Adoptium]\n\
name=Adoptium\n\
baseurl=https://packages.adoptium.net/artifactory/rpm/${DISTRIBUTION_NAME:-$(. /etc/os-release; echo $ID)}/\$releasever/\$basearch\n\
enabled=1\n\
gpgcheck=1\n\
gpgkey=https://packages.adoptium.net/artifactory/api/gpg/key/public\n\
" > /etc/yum.repos.d/adoptium.repo

RUN yum install -y temurin-17-jdk && \
    yum clean all

ENV JAVA_HOME=/usr/lib/jvm/java-17-temurin-jdk
ENV PATH=$JAVA_HOME/bin:$PATH

# 3. Ensure Hadoop knows where Java is
ENV HADOOP_JAVA_HOME=$JAVA_HOME

USER hadoop