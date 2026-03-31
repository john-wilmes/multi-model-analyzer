/**
 * Cross-repo service topology detection.
 *
 * Detects inter-service communication patterns from tree-sitter ASTs:
 * - Queue producers: queue.add(), addBulk(), @InjectQueue, custom queue framework patterns (config-driven)
 * - Queue consumers: @Process(), @Processor(), extends *WorkerService, initWorker(),
 *   custom queue framework patterns (config-driven)
 * - HTTP clients: fetch(), axios/got calls, HttpService injection
 *
 * Produces "service-call" graph edges with protocol metadata.
 */

import type { GraphEdge, CustomQueueFramework } from "@mma/core";
import type { TreeSitterNode, TreeSitterTree } from "@mma/parsing";

export interface ServiceTopologyInput {
  readonly repo: string;
  readonly trees: ReadonlyMap<string, TreeSitterTree>;
  readonly imports: ReadonlyMap<string, readonly string[]>;
  readonly customQueueFrameworks?: readonly CustomQueueFramework[];
}

export interface ServiceCallEdge {
  readonly sourceFile: string;
  readonly targetService: string;
  readonly protocol: "queue" | "http" | "websocket";
  readonly detail: string;
}

/**
 * Extract service topology edges from tree-sitter ASTs.
 * Returns GraphEdge[] with kind "service-call".
 */
export function extractServiceTopology(
  input: ServiceTopologyInput,
): GraphEdge[] {
  const edges: GraphEdge[] = [];

  for (const [filePath, tree] of input.trees) {
    const fileImports = input.imports.get(filePath) ?? [];

    // Detect queue producers
    const queueProducers = findQueueProducers(tree.rootNode, filePath, fileImports, input.customQueueFrameworks ?? []);
    for (const producer of queueProducers) {
      edges.push({
        source: filePath,
        target: producer.queueName,
        kind: "service-call",
        metadata: {
          repo: input.repo,
          protocol: "queue",
          role: "producer",
          detail: producer.detail,
        },
      });
    }

    // Detect queue consumers
    const queueConsumers = findQueueConsumers(tree.rootNode, filePath, fileImports, input.customQueueFrameworks ?? []);
    for (const consumer of queueConsumers) {
      edges.push({
        source: filePath,
        target: consumer.queueName,
        kind: "service-call",
        metadata: {
          repo: input.repo,
          protocol: "queue",
          role: "consumer",
          detail: consumer.detail,
        },
      });
    }

    // Detect HTTP client calls
    const httpCalls = findHttpCalls(tree.rootNode, filePath, fileImports);
    for (const call of httpCalls) {
      edges.push({
        source: filePath,
        target: call.target,
        kind: "service-call",
        metadata: {
          repo: input.repo,
          protocol: "http",
          role: "client",
          detail: call.detail,
        },
      });
    }

    // Detect WebSocket patterns
    const wsCalls = findWebSocketCalls(tree.rootNode, filePath, fileImports);
    for (const ws of wsCalls) {
      edges.push({
        source: filePath,
        target: ws.target,
        kind: "service-call",
        metadata: {
          repo: input.repo,
          protocol: "websocket",
          role: ws.role,
          detail: ws.detail,
        },
      });
    }
  }

  return edges;
}

interface QueueRef {
  readonly queueName: string;
  readonly detail: string;
}

interface HttpRef {
  readonly target: string;
  readonly detail: string;
}

// Queue name patterns from BullMQ / Bull / NestJS decorators
const QUEUE_SERVICE_PATTERN =
  /^(Standard|Workflow|WebSocket|Subscriber|InboundParse|ActiveJobsMetric)QueueService$/;
const QUEUE_ADD_METHODS = new Set(["add", "addBulk", "addToQueue"]);
const WORKER_SERVICE_PATTERN = /^(Standard|Workflow)Worker(Service)?$/;

// Libraries that use queue-like APIs but are NOT message brokers.
// p-queue is a local in-memory concurrency limiter, not a service bus.
const NON_BROKER_QUEUE_IMPORTS = new Set(["p-queue"]);

/**
 * Find queue producer patterns:
 * - Constructor injection of *QueueService + method calls to .add()/.addBulk()
 * - Direct queue.add() calls
 * - @InjectQueue('name') decorators
 * - Custom queue framework member access patterns (config-driven)
 */
function findQueueProducers(
  rootNode: TreeSitterNode,
  _filePath: string,
  fileImports: readonly string[] = [],
  customQueueFrameworks: readonly CustomQueueFramework[] = [],
): QueueRef[] {
  // If the file imports a non-broker queue library (e.g. p-queue), skip
  // heuristic .add()/.addBulk() detection — those calls are concurrency
  // control, not message-queue producers.
  const usesNonBrokerQueue = fileImports.some((imp) =>
    [...NON_BROKER_QUEUE_IMPORTS].some(
      (pkg) => imp === pkg || imp.startsWith(`${pkg}/`),
    ),
  );

  // Collect all active custom frameworks (those whose importTrigger is present)
  const activeFrameworks = customQueueFrameworks.filter((fw) =>
    fileImports.some(
      (imp) => imp === fw.importTrigger || imp.startsWith(`${fw.importTrigger}/`),
    ),
  );

  // Collect all memberObject names from ALL configured frameworks for Pass 2 exclusion.
  // We exclude these regardless of import presence so that the generic name heuristic
  // never fires on custom-framework objects — the framework's own Pass 3 handles them
  // with proper import-gating.
  const customMemberObjects = new Set<string>(
    customQueueFrameworks.flatMap((fw) => (fw.producers ?? []).map((p) => p.memberObject)),
  );

  const results: QueueRef[] = [];
  // Map from field name -> queue name (derived from injected type)
  const queueFields = new Map<string, string>();

  // Pass 1: Collect constructor injections so queueFields is populated
  // before we look for .add() calls (constructor may appear after methods).
  visitNodes(rootNode, (node) => {
    if (node.type === "method_definition") {
      const nameNode = node.childForFieldName("name");
      if (nameNode?.text === "constructor") {
        const params = node.childForFieldName("parameters");
        if (params) {
          for (let i = 0; i < params.namedChildCount; i++) {
            const param = params.namedChild(i);
            const typeAnnotation = findTypeAnnotation(param);
            if (typeAnnotation && QUEUE_SERVICE_PATTERN.test(typeAnnotation)) {
              const paramName = findParamName(param);
              if (paramName) {
                const queueName = typeAnnotation
                  .replace("QueueService", "")
                  .toLowerCase();
                queueFields.set(paramName, queueName);
              }
            }
          }
        }
      }
    }
  });

  // Pass 2: Find .add()/.addBulk() calls and @InjectQueue decorators.
  visitNodes(rootNode, (node) => {
    // In BullMQ, queue.add(jobName, data) -- first arg is the job name, not queue name.
    // The queue name comes from the injected service type.
    if (
      node.type === "call_expression" &&
      node.childForFieldName("function")?.type === "member_expression"
    ) {
      const memberExpr = node.childForFieldName("function")!;
      const method = memberExpr.childForFieldName("property")?.text;
      if (method && QUEUE_ADD_METHODS.has(method)) {
        const object = memberExpr.childForFieldName("object");
        const objectText = object?.text ?? "";
        const objectKey = objectText.startsWith("this.")
          ? objectText.slice(5)
          : objectText;
        // Check if object is a known queue field or matches queue pattern.
        // When a non-broker queue lib (p-queue) is imported, only trust
        // explicitly typed queue fields — the generic name heuristic would
        // false-positive on PQueue.add() / queue.add().
        const isKnownQueueField = queueFields.has(objectKey);
        // Exclude custom framework member objects — handled by Pass 3 below.
        const isCustomMemberObject =
          customMemberObjects.has(objectText) ||
          customMemberObjects.has(objectKey) ||
          [...customMemberObjects].some(
            (mo) => objectText.includes(`${mo}.`) || objectText.includes(`.${mo.charAt(0).toLowerCase()}${mo.slice(1)}.`),
          );
        const matchesNameHeuristic =
          !usesNonBrokerQueue &&
          !isCustomMemberObject &&
          (objectKey.endsWith("Queue") || objectKey.endsWith("queue"));
        if (isKnownQueueField || matchesNameHeuristic) {
          const args = node.childForFieldName("arguments");
          const jobName = extractFirstStringArg(args);
          const queueName = queueFields.get(objectKey) ?? objectKey;
          results.push({
            queueName,
            detail: jobName
              ? `${objectText}.${method}('${jobName}')`
              : `${objectText}.${method}()`,
          });
        }
      }
    }

    // @InjectQueue('name') decorator
    if (node.type === "decorator") {
      const expr = node.namedChild(0);
      if (
        expr?.type === "call_expression" &&
        expr.childForFieldName("function")?.text === "InjectQueue"
      ) {
        const args = expr.childForFieldName("arguments");
        const queueName = extractFirstStringArg(args);
        if (queueName) {
          results.push({ queueName, detail: "@InjectQueue" });
        }
      }
    }
  });

  // Pass 3: Config-driven custom queue framework producer patterns.
  // For each active framework, scan for member_expression nodes matching
  // any producers[].memberObject.
  for (const framework of activeFrameworks) {
    for (const producer of framework.producers ?? []) {
      const { memberObject } = producer;
      visitNodes(rootNode, (node) => {
        if (node.type === "member_expression") {
          const object = node.childForFieldName("object");
          const property = node.childForFieldName("property");
          if (!object || !property) return;
          const objectText = object.text;
          if (
            objectText === memberObject ||
            objectText.endsWith(`.${memberObject}`) ||
            objectText === memberObject.charAt(0).toLowerCase() + memberObject.slice(1) ||
            objectText.endsWith(`.${memberObject.charAt(0).toLowerCase()}${memberObject.slice(1)}`)
          ) {
            const queueName = property.text;
            results.push({
              queueName,
              detail: `${objectText}.${queueName}`,
            });
          }
        }
      });
    }
  }

  return results;
}

/**
 * Find queue consumer patterns:
 * - @Process() / @Processor() decorators
 * - Classes extending *WorkerService
 * - initWorker() / createWorker() calls
 * - Custom queue framework patterns (config-driven): classProperty and methodCall consumers
 */
function findQueueConsumers(
  rootNode: TreeSitterNode,
  _filePath: string,
  fileImports: readonly string[] = [],
  customQueueFrameworks: readonly CustomQueueFramework[] = [],
): QueueRef[] {
  const results: QueueRef[] = [];
  // Track (nodeStartIndex, frameworkIndex, consumerIndex) to prevent a consumer
  // with both methodCall and classProperty from emitting the same node twice.
  const seenConsumerNodes = new Set<string>();

  // Collect active custom frameworks for this file
  const activeFrameworks = customQueueFrameworks.filter((fw) =>
    fileImports.some(
      (imp) => imp === fw.importTrigger || imp.startsWith(`${fw.importTrigger}/`),
    ),
  );

  visitNodes(rootNode, (node) => {
    // Strategy 1: @Processor('queueName') binds a class to a queue;
    // @Process('jobName') filters a handler within that queue (not a queue name).
    if (node.type === "decorator") {
      const expr = node.namedChild(0);
      if (expr?.type === "call_expression") {
        const funcName = expr.childForFieldName("function")?.text;
        if (funcName === "Processor") {
          const args = expr.childForFieldName("arguments");
          const queueName = extractFirstStringArg(args) ?? "unknown";
          results.push({
            queueName,
            detail: `@Processor('${queueName}')`,
          });
        } else if (funcName === "Process") {
          const args = expr.childForFieldName("arguments");
          const jobName = extractFirstStringArg(args);
          results.push({
            queueName: "unknown",
            detail: jobName ? `@Process('${jobName}')` : "@Process()",
          });
        }
      }
    }

    // Strategy 2: class ... extends *WorkerService (strip generics for matching)
    if (node.type === "class_declaration" || node.type === "class") {
      const heritage = findHeritageClause(node);
      const heritageBase = heritage?.replace(/<.*>$/, "");
      if (heritageBase && WORKER_SERVICE_PATTERN.test(heritageBase)) {
        const queueName = heritageBase
          .replace("WorkerService", "")
          .replace("Worker", "")
          .toLowerCase();
        results.push({
          queueName: queueName || "worker",
          detail: `extends ${heritage}`,
        });
      }
    }

    // Strategy 3: initWorker() / createWorker() calls
    if (node.type === "call_expression") {
      const func = node.childForFieldName("function");
      if (func?.type === "member_expression") {
        const method = func.childForFieldName("property")?.text;
        if (method === "initWorker" || method === "createWorker") {
          const args = node.childForFieldName("arguments");
          const queueName = extractFirstStringArg(args) ?? "worker";
          results.push({
            queueName,
            detail: `${method}()`,
          });
        }
      }
    }

    // Config-driven methodCall consumers
    for (let fi = 0; fi < activeFrameworks.length; fi++) {
      const framework = activeFrameworks[fi]!;
      for (let ci = 0; ci < (framework.consumers ?? []).length; ci++) {
        const consumer = framework.consumers![ci]!;
        if (consumer.methodCall && !consumer.classProperty && node.type === "call_expression") {
          const func = node.childForFieldName("function");
          if (func?.type === "member_expression") {
            const method = func.childForFieldName("property")?.text;
            if (method === consumer.methodCall) {
              const seenKey = `${node.startIndex}:${fi}:${ci}`;
              if (!seenConsumerNodes.has(seenKey)) {
                seenConsumerNodes.add(seenKey);
                results.push({
                  queueName: consumer.target ?? "unknown",
                  detail: `${consumer.methodCall}()`,
                });
              }
            }
          }
        }
      }
    }
  });

  // Config-driven classProperty consumers.
  // Covers TypeScript `public_field_definition` (readonly propName = '...') and
  // JS constructor assignment `this.propName = '...'`.
  for (let fi = 0; fi < activeFrameworks.length; fi++) {
    const framework = activeFrameworks[fi]!;
    for (let ci = 0; ci < (framework.consumers ?? []).length; ci++) {
      const consumer = framework.consumers![ci]!;
      if (!consumer.classProperty) continue;
      const propName = consumer.classProperty;
      visitNodes(rootNode, (node) => {
        // TypeScript class field: readonly <propName> = 'QueueName'
        if (
          node.type === "public_field_definition" ||
          node.type === "property_declaration"
        ) {
          const nameNode =
            node.childForFieldName("name") ??
            findChildByType(node, "property_identifier", "identifier");
          if (nameNode?.text === propName) {
            const valueNode =
              node.childForFieldName("value") ??
              findChildByType(node, "string");
            const queueName = valueNode
              ? extractStringValue(valueNode)
              : null;
            if (queueName) {
              const seenKey = `${node.startIndex}:${fi}:${ci}`;
              if (!seenConsumerNodes.has(seenKey)) {
                seenConsumerNodes.add(seenKey);
                results.push({
                  queueName,
                  detail: `${propName} = '${queueName}'`,
                });
              }
            }
          }
        }

        // JS constructor assignment: this.<propName> = 'QueueName'
        if (node.type === "assignment_expression") {
          const left = node.childForFieldName("left");
          const right = node.childForFieldName("right");
          if (
            left?.type === "member_expression" &&
            left.childForFieldName("object")?.text === "this" &&
            left.childForFieldName("property")?.text === propName &&
            right?.type === "string"
          ) {
            const queueName = extractStringValue(right);
            if (queueName) {
              const seenKey = `${node.startIndex}:${fi}:${ci}`;
              if (!seenConsumerNodes.has(seenKey)) {
                seenConsumerNodes.add(seenKey);
                results.push({
                  queueName,
                  detail: `${propName} = '${queueName}'`,
                });
              }
            }
          }
        }
      });
    }
  }

  return results;
}

/**
 * Find HTTP client call patterns:
 * - fetch() calls
 * - axios.get/post/put/delete() calls
 * - got.get/post() calls
 * - HttpService injection (NestJS)
 */
function findHttpCalls(
  rootNode: TreeSitterNode,
  _filePath: string,
  fileImports: readonly string[],
): HttpRef[] {
  const results: HttpRef[] = [];
  const usesAxios = fileImports.some(
    (imp) => imp === "axios" || imp.startsWith("axios/"),
  );
  const usesGot = fileImports.some(
    (imp) => imp === "got" || imp.startsWith("got/"),
  );
  const usesHttpService = fileImports.some(
    (imp) => imp === "@nestjs/axios",
  );

  const httpMethods = new Set([
    "get",
    "post",
    "put",
    "patch",
    "delete",
    "head",
    "options",
    "request",
  ]);

  visitNodes(rootNode, (node) => {
    if (node.type !== "call_expression") return;

    const func = node.childForFieldName("function");
    if (!func) return;

    // fetch() calls
    if (func.text === "fetch" || func.text === "globalThis.fetch") {
      const args = node.childForFieldName("arguments");
      const url = extractFirstStringArg(args);
      results.push({
        target: url ?? "external-api",
        detail: "fetch()",
      });
      return;
    }

    // Member expression calls: axios.get(), got.post(), httpService.get(), etc.
    if (func.type === "member_expression") {
      const object = func.childForFieldName("object");
      const method = func.childForFieldName("property")?.text;

      if (!method || !httpMethods.has(method)) return;

      const objectText = object?.text ?? "";

      // axios/got calls (fetch is a function, not an object -- handled above)
      if (
        (usesAxios && objectText === "axios") ||
        (usesGot && objectText === "got")
      ) {
        const args = node.childForFieldName("arguments");
        const url = extractFirstStringArg(args);
        results.push({
          target: url ?? "external-api",
          detail: `${objectText}.${method}()`,
        });
        return;
      }

      // HttpService calls (NestJS)
      if (
        usesHttpService &&
        (objectText === "httpService" ||
          objectText === "this.httpService" ||
          objectText.endsWith("HttpService"))
      ) {
        const args = node.childForFieldName("arguments");
        const url = extractFirstStringArg(args);
        results.push({
          target: url ?? "external-api",
          detail: `HttpService.${method}()`,
        });
      }
    }
  });

  return results;
}

interface WebSocketRef {
  readonly target: string;
  readonly role: "server" | "client";
  readonly detail: string;
}

/**
 * Find WebSocket patterns:
 * - @WebSocketGateway() decorators (NestJS server)
 * - @SubscribeMessage() decorators (NestJS server)
 * - socket.emit()/socket.on() with socket.io-client imports (client)
 */
function findWebSocketCalls(
  rootNode: TreeSitterNode,
  _filePath: string,
  fileImports: readonly string[],
): WebSocketRef[] {
  const results: WebSocketRef[] = [];
  const usesSocketClient = fileImports.some(
    (imp) => imp === "socket.io-client" || imp.startsWith("socket.io-client/"),
  );
  const usesNestWs = fileImports.some(
    (imp) => imp === "@nestjs/websockets",
  );

  visitNodes(rootNode, (node) => {
    // @WebSocketGateway() decorator (NestJS server)
    if (node.type === "decorator" && usesNestWs) {
      const expr = node.namedChild(0);
      if (expr?.type === "call_expression") {
        const funcName = expr.childForFieldName("function")?.text;
        if (funcName === "WebSocketGateway") {
          const args = expr.childForFieldName("arguments");
          const port = extractFirstStringArg(args);
          results.push({
            target: port ? `ws://localhost:${port}` : "websocket-gateway",
            role: "server",
            detail: port ? `@WebSocketGateway(${port})` : "@WebSocketGateway()",
          });
        }
      }
    }

    // @SubscribeMessage('event') decorator (NestJS server)
    if (node.type === "decorator" && usesNestWs) {
      const expr = node.namedChild(0);
      if (expr?.type === "call_expression") {
        const funcName = expr.childForFieldName("function")?.text;
        if (funcName === "SubscribeMessage") {
          const args = expr.childForFieldName("arguments");
          const event = extractFirstStringArg(args);
          results.push({
            target: event ?? "websocket-event",
            role: "server",
            detail: event ? `@SubscribeMessage('${event}')` : "@SubscribeMessage()",
          });
        }
      }
    }

    // socket.emit()/socket.on() with socket.io-client
    if (
      node.type === "call_expression" &&
      usesSocketClient &&
      node.childForFieldName("function")?.type === "member_expression"
    ) {
      const memberExpr = node.childForFieldName("function")!;
      const method = memberExpr.childForFieldName("property")?.text;
      if (method === "emit" || method === "on") {
        const objectText = memberExpr.childForFieldName("object")?.text ?? "";
        // Only match socket-like objects (not arbitrary .emit calls)
        if (/socket/i.test(objectText) || objectText === "io") {
          const args = node.childForFieldName("arguments");
          const event = extractFirstStringArg(args);
          results.push({
            target: event ?? "websocket-event",
            role: "client",
            detail: event
              ? `${objectText}.${method}('${event}')`
              : `${objectText}.${method}()`,
          });
        }
      }
    }
  });

  return results;
}

// --- AST helpers ---

/**
 * Find the first direct named child of `node` whose type matches one of the
 * given types. Used in place of inline IIFEs that loop over namedChildren.
 */
function findChildByType(
  node: TreeSitterNode,
  ...types: string[]
): TreeSitterNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i)!;
    if (types.includes(c.type)) return c;
  }
  return null;
}

function visitNodes(
  node: TreeSitterNode,
  callback: (node: TreeSitterNode) => void,
): void {
  callback(node);
  for (let i = 0; i < node.namedChildCount; i++) {
    visitNodes(node.namedChild(i)!, callback);
  }
}

function findTypeAnnotation(param: TreeSitterNode | null): string | null {
  if (!param) return null;
  for (let i = 0; i < param.namedChildCount; i++) {
    const child = param.namedChild(i)!;
    if (child.type === "type_annotation") {
      // The type is the last named child of the annotation
      const type = child.namedChild(child.namedChildCount - 1);
      return type?.text ?? null;
    }
  }
  return null;
}

function findParamName(param: TreeSitterNode | null): string | null {
  if (!param) return null;
  // For patterns like "private readonly fieldName: Type"
  // The identifier is typically the first child
  for (let i = 0; i < param.namedChildCount; i++) {
    const child = param.namedChild(i)!;
    if (child.type === "identifier") return child.text;
  }
  // Try the pattern node
  const pattern = param.childForFieldName("pattern");
  if (pattern) return pattern.text;
  return null;
}

function findHeritageClause(classNode: TreeSitterNode): string | null {
  for (let i = 0; i < classNode.namedChildCount; i++) {
    const child = classNode.namedChild(i)!;
    if (child.type === "class_heritage") {
      // Find the extends clause
      for (let j = 0; j < child.namedChildCount; j++) {
        const clause = child.namedChild(j)!;
        if (clause.type === "extends_clause") {
          const value = clause.namedChild(0);
          return value?.text ?? null;
        }
      }
    }
  }
  return null;
}

/** Extract string value from a string literal node, stripping quotes. */
function extractStringValue(node: TreeSitterNode): string | null {
  const text = node.text;
  if (
    (text.startsWith("'") && text.endsWith("'")) ||
    (text.startsWith('"') && text.endsWith('"'))
  ) {
    return text.slice(1, -1);
  }
  if (text.startsWith("`") && text.endsWith("`")) {
    return text.slice(1, -1);
  }
  return null;
}

function extractFirstStringArg(
  argsNode: TreeSitterNode | null,
): string | null {
  if (!argsNode) return null;
  for (let i = 0; i < argsNode.namedChildCount; i++) {
    const arg = argsNode.namedChild(i)!;
    if (arg.type === "number") {
      return arg.text;
    }
    if (arg.type === "string" || arg.type === "template_string") {
      return extractStringValue(arg) ?? arg.text;
    }
  }
  return null;
}
