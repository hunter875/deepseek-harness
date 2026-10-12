ARG MAVEN_BASE
ARG JAVA_BASE
FROM ${MAVEN_BASE} AS builder
ARG SERVICE
WORKDIR /src
COPY backend-java/${SERVICE}/ ./
RUN sed -i 's/\r$//' mvnw && chmod +x mvnw && ./mvnw package -B
FROM ${JAVA_BASE}
WORKDIR /app
RUN addgroup --system app && adduser --system --ingroup app app
COPY --from=builder /src/target/*.jar /app/app.jar
USER app
CMD ["java", "-jar", "/app/app.jar"]
