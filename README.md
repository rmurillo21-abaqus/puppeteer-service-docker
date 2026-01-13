# puppeteer-service-docker

2. EXPORT AWS_PROFILE=abaqus-dev
3. aws ecr get-login-password --region us-west-2 | docker login --username AWS --password-stdin 345002264488.dkr.ecr.us-west-2.amazonaws.com
4. docker build -t allgeo/puppeteer .
5. docker tag allgeo/puppeteer:latest 345002264488.dkr.ecr.us-west-2.amazonaws.com/allgeo/puppeteer:latest
6. docker push 345002264488.dkr.ecr.us-west-2.amazonaws.com/allgeo/puppeteer:latest
