import { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Skip auth if no API key is configured (development mode)
  if (!config.apiSecretKey) {
    next();
    return;
  }

  const apiKey = req.headers['x-api-key'];
  if (apiKey !== config.apiSecretKey) {
    res.status(401).json({ success: false, error: 'Invalid or missing API key' });
    return;
  }
  next();
}
