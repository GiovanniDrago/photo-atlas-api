export function registerOctetStreamParser(app) {
  app.addContentTypeParser('application/octet-stream', (request, payload, done) => {
    done(null, payload);
  });
}
