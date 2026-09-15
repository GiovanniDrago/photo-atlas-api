import { config } from '../config.js';

export const corsOptions = {
  origin:
    config.corsOrigin === '*'
      ? true
      : config.corsOrigin.split(',').map((entry) => entry.trim()),
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
};
