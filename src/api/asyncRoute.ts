import type { NextFunction, Request, RequestHandler, Response } from "express";

/** Wraps an async Express handler so a rejected promise reaches the error middleware instead of hanging the request. */
export function asyncRoute(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
