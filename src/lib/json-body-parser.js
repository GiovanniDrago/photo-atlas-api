export function registerJsonBodyParser(app) {
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (request, body, done) => {
      if (body === '' || body == null) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(body));
      } catch (error) {
        error.statusCode = 400;
        done(error);
      }
    },
  );
}
