import { auth, toNextJsHandler } from "@watchthatsite/auth/next";

export const runtime = "nodejs";

export const { POST, GET } = toNextJsHandler(auth);
