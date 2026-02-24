#!/usr/bin/env node
// Entrypoint del nodo validador — ejecutar con: node dist/server.js
import { startValidatorNode } from "./validator.js";

const port = parseInt(process.env.SOULPRINT_PORT ?? "4888");
startValidatorNode(port);
