import { config } from '../config.js';

export const corsOptions = {
  origin:
    config.corsOrigin === '*'
      ? true
      : config.corsOrigin.split(',').map((entry) => entry.trim()),
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
  // The web video player needs to read these from range responses.
  exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length'],
};
