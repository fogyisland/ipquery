import type { FastifyInstance } from "fastify";
/**
 * Liveness and schema drift, in one response.
 *
 * The status line is the load balancer's question: is this process serving.
 * The `schema` block is the operator's, and it is here because the two are
 * routinely confused — a deployment whose database is a migration behind the
 * code reports `ok` right up to the moment a query touches a column that
 * does not exist. Reporting the pending count turns that silent gap into
 * something a monitor can alert on before a request hits it.
 */
export default function healthRoute(app: FastifyInstance): Promise<void>;
