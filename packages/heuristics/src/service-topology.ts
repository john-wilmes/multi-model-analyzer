/**
 * Cross-repo service topology detection.
 *
 * Detects inter-service communication patterns from tree-sitter ASTs:
 * - Queue producers: queue.add(), addBulk(), @InjectQueue
 * - Queue consumers: @Process(), @Processor(), Worker.on('completed')
 * - HTTP clients: fetch(), axios/got calls, HttpService injection
 *
 * Produces "service-call" graph edges with protocol metadata.
 */

import type { GraphEdge } from "@mma/core";
import type { TreeSitterNode, TreeSitterTree } from "@mma/parsing";

export interface ServiceTopologyInput {
  readonly repo: string;
  readonly trees: ReadonlyMap<string, TreeSitterTree>;
  readonly imports: ReadonlyMap<string, readonly string[]>;
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
    const queueProducers = findQueueProducers(tree.rootNode, filePath);
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
    const queueConsumers = findQueueConsumers(tree.rootNode, filePath);
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

/**
 * Find queue producer patterns:
 * - Constructor injection of *QueueService + method calls to .add()/.addBulk()
 * - Direct queue.add() calls
 * - @InjectQueue('name') decorators
 */
function findQueueProducers(
  rootNode: TreeSitterNode,
  _filePath: string,
): QueueRef[] {
  const results: QueueRef[] = [];
  const queueFields = new Set<string>();

  // Strategy 1: Find constructor params matching *QueueService pattern
  visitNodes(rootNode, (node) => {
    if (
      node.type === "required_parameter" ||
      node.type === "formal_parameters"
    ) {
      return; // skip, handled below
    }

    // Find class constructors with queue service injections
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
                queueFields.add(paramName);
                const queueName = typeAnnotation
                  .replace("QueueService", "")
                  .toLowerCase();
                results.push({
                  queueName,
                  detail: `${typeAnnotation} injected`,
                });
              }
            }
          }
        }
      }
    }

    // Strategy 2: Find .add() / .addBulk() calls on queue fields
    if (
      node.type === "call_expression" &&
      node.childForFieldName("function")?.type === "member_expression"
    ) {
      const memberExpr = node.childForFieldName("function")!;
      const method = memberExpr.childForFieldName("property")?.text;
      if (method && QUEUE_ADD_METHODS.has(method)) {
        const object = memberExpr.childForFieldName("object");
        const objectText = object?.text ?? "";
        // Check if object is a known queue field or matches queue pattern
        if (
          queueFields.has(objectText) ||
          objectText.endsWith("Queue") ||
          objectText.endsWith("queue")
        ) {
          // Try to extract queue name from arguments
          const args = node.childForFieldName("arguments");
          const queueName = extractFirstStringArg(args) ?? objectText;
          results.push({
            queueName,
            detail: `${objectText}.${method}()`,
          });
        }
      }
    }

    // Strategy 3: @InjectQueue('name') decorator
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

  return results;
}

/**
 * Find queue consumer patterns:
 * - @Process() / @Processor() decorators
 * - Classes extending *WorkerService
 * - worker.on('completed') / worker.on('failed') event handlers
 * - initWorker() calls
 */
function findQueueConsumers(
  rootNode: TreeSitterNode,
  _filePath: string,
): QueueRef[] {
  const results: QueueRef[] = [];

  visitNodes(rootNode, (node) => {
    // Strategy 1: @Processor('queueName') or @Process('jobName') decorators
    if (node.type === "decorator") {
      const expr = node.namedChild(0);
      if (expr?.type === "call_expression") {
        const funcName = expr.childForFieldName("function")?.text;
        if (funcName === "Processor" || funcName === "Process") {
          const args = expr.childForFieldName("arguments");
          const queueName = extractFirstStringArg(args) ?? "unknown";
          results.push({
            queueName,
            detail: `@${funcName}('${queueName}')`,
          });
        }
      }
    }

    // Strategy 2: class ... extends *WorkerService
    if (node.type === "class_declaration" || node.type === "class") {
      const heritage = findHeritageClause(node);
      if (heritage && WORKER_SERVICE_PATTERN.test(heritage)) {
        const queueName = heritage
          .replace("WorkerService", "")
          .replace("Worker", "")
          .toLowerCase();
        results.push({
          queueName: queueName || "worker",
          detail: `extends ${heritage}`,
        });
      }
    }

    // Strategy 3: initWorker() calls
    if (node.type === "call_expression") {
      const func = node.childForFieldName("function");
      if (func?.type === "member_expression") {
        const method = func.childForFieldName("property")?.text;
        if (method === "initWorker" || method === "createWorker") {
          results.push({
            queueName: "worker",
            detail: `${method}()`,
          });
        }
      }
    }
  });

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
    (imp) => imp === "@nestjs/axios" || imp === "@nestjs/common",
  );

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

      if (!method || !httpMethods.has(method)) return;

      const objectText = object?.text ?? "";

      // axios/got calls
      if (
        (usesAxios && objectText === "axios") ||
        (usesGot && (objectText === "got" || objectText === "request")) ||
        objectText === "fetch"
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

// --- AST helpers ---

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
    if (
      child.type === "identifier" ||
      child.type === "accessibility_modifier"
    ) {
      if (child.type === "identifier") return child.text;
    }
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

function extractFirstStringArg(
  argsNode: TreeSitterNode | null,
): string | null {
  if (!argsNode) return null;
  for (let i = 0; i < argsNode.namedChildCount; i++) {
    const arg = argsNode.namedChild(i)!;
    if (arg.type === "string" || arg.type === "template_string") {
      // Strip quotes
      const text = arg.text;
      if (
        (text.startsWith("'") && text.endsWith("'")) ||
        (text.startsWith('"') && text.endsWith('"'))
      ) {
        return text.slice(1, -1);
      }
      if (text.startsWith("`") && text.endsWith("`")) {
        return text.slice(1, -1);
      }
      return text;
    }
  }
  return null;
}
