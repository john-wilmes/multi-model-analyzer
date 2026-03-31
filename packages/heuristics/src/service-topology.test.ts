/**
 * Tests for cross-repo service topology detection.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { initTreeSitter, parseSource } from "@mma/parsing";
import type { TreeSitterTree } from "@mma/parsing";
import { extractServiceTopology } from "./service-topology.js";
import type { ServiceTopologyInput } from "./service-topology.js";

beforeAll(async () => {
  await initTreeSitter();
}, 15_000);

function makeInput(
  files: { path: string; source: string; imports?: string[] }[],
  repo = "test-repo",
): ServiceTopologyInput {
  const trees = new Map<string, TreeSitterTree>();
  const imports = new Map<string, readonly string[]>();
  for (const f of files) {
    trees.set(f.path, parseSource(f.source, f.path));
    if (f.imports) {
      imports.set(f.path, f.imports);
    }
  }
  return { repo, trees, imports };
}

describe("extractServiceTopology", () => {
  describe("queue producers", () => {
    it("detects constructor-injected queue service with .add() call", () => {
      const source = `
class NotificationService {
  constructor(private standardQueueService: StandardQueueService) {}
  async send() {
    await this.standardQueueService.add('send-email', { to: 'user@test.com' });
  }
}`;
      const input = makeInput([{ path: "notification.ts", source }]);
      const edges = extractServiceTopology(input);

      expect(edges.length).toBeGreaterThanOrEqual(1);
      const queueEdge = edges.find(
        (e) => e.metadata?.protocol === "queue" && e.metadata?.role === "producer",
      );
      expect(queueEdge).toBeDefined();
      expect(queueEdge!.target).toBe("standard");
      expect(queueEdge!.metadata?.detail).toContain("add");
      expect(queueEdge!.metadata?.detail).toContain("send-email");
    });

    it("detects @InjectQueue decorator", () => {
      const source = `
class JobService {
  constructor(@InjectQueue('email') private emailQueue: Queue) {}
}`;
      const input = makeInput([{ path: "job.ts", source }]);
      const edges = extractServiceTopology(input);

      const queueEdge = edges.find(
        (e) => e.metadata?.protocol === "queue" && e.metadata?.role === "producer",
      );
      expect(queueEdge).toBeDefined();
      expect(queueEdge!.target).toBe("email");
      expect(queueEdge!.metadata?.detail).toBe("@InjectQueue");
    });

    it("ignores p-queue .add() calls (not a message broker)", () => {
      const source = `
import PQueue from 'p-queue';
const queue = new PQueue({ concurrency: 4 });
await queue.add(() => fetchData());`;
      const input = makeInput([
        { path: "concurrency.ts", source, imports: ["p-queue"] },
      ]);
      const edges = extractServiceTopology(input);

      const queueEdge = edges.find(
        (e) => e.metadata?.protocol === "queue" && e.metadata?.role === "producer",
      );
      expect(queueEdge).toBeUndefined();
    });

    it("still detects BullMQ when p-queue is also imported", () => {
      const source = `
import PQueue from 'p-queue';
class Sender {
  constructor(private standardQueueService: StandardQueueService) {}
  async send() {
    const pQueue = new PQueue({ concurrency: 2 });
    await pQueue.add(() => this.standardQueueService.add('job', {}));
  }
}`;
      const input = makeInput([
        { path: "mixed-queues.ts", source, imports: ["p-queue"] },
      ]);
      const edges = extractServiceTopology(input);

      // Should detect the BullMQ StandardQueueService.add() but NOT pQueue.add()
      const producers = edges.filter(
        (e) => e.metadata?.protocol === "queue" && e.metadata?.role === "producer",
      );
      // The known typed field (standardQueueService) should still be detected
      expect(producers.some((e) => e.target === "standard")).toBe(true);
      // The pQueue.add() should NOT be detected as a queue producer
      expect(producers.some((e) => e.metadata?.detail?.toString().includes("pQueue"))).toBe(false);
    });

    it("detects .addBulk() calls on queue fields", () => {
      const source = `
class BulkSender {
  constructor(private workflowQueueService: WorkflowQueueService) {}
  async sendAll() {
    await this.workflowQueueService.addBulk([{ name: 'job1' }]);
  }
}`;
      const input = makeInput([{ path: "bulk.ts", source }]);
      const edges = extractServiceTopology(input);

      const queueEdge = edges.find(
        (e) => e.metadata?.protocol === "queue" && e.metadata?.role === "producer",
      );
      expect(queueEdge).toBeDefined();
      expect(queueEdge!.target).toBe("workflow");
      expect(queueEdge!.metadata?.detail).toContain("addBulk");
    });

    describe("custom queue framework patterns", () => {
      const customFrameworks = [{
        importTrigger: "my-queue-lib",
        producers: [{ memberObject: "MyQueues" }],
        consumers: [
          { classProperty: "queueName" },
          { methodCall: "subscribeFromListeners", target: "event-bus" },
        ],
      }];

      it("detects custom member access producer with matching import", () => {
        const source = `
const MyQueues = lib.queues;
function enqueue() {
  MyQueues.StatusQueue.add({ status: 'sent' });
}`;
        const input = makeInput([
          { path: "enqueue.ts", source, imports: ["my-queue-lib"] },
        ]);
        const edges = extractServiceTopology({ ...input, customQueueFrameworks: customFrameworks });
        const queueEdge = edges.find(
          (e) => e.metadata?.protocol === "queue" && e.metadata?.role === "producer",
        );
        expect(queueEdge).toBeDefined();
        expect(queueEdge!.target).toBe("StatusQueue");
        expect(queueEdge!.metadata?.detail).toContain("MyQueues");
      });

      it("ignores custom member access without matching import", () => {
        const source = `
MyQueues.SomeQueue.add({ data: 1 });`;
        const input = makeInput([{ path: "no-import.ts", source }]);
        const edges = extractServiceTopology({ ...input, customQueueFrameworks: customFrameworks });
        const queueEdge = edges.find(
          (e) => e.metadata?.protocol === "queue" && e.metadata?.role === "producer",
        );
        expect(queueEdge).toBeUndefined();
      });
    });
  });

  describe("queue consumers", () => {
    it("detects @Processor decorator", () => {
      const source = `
@Processor('notifications')
class NotificationProcessor {
  async handle(job: Job) {}
}`;
      const input = makeInput([{ path: "processor.ts", source }]);
      const edges = extractServiceTopology(input);

      const consumerEdge = edges.find(
        (e) => e.metadata?.protocol === "queue" && e.metadata?.role === "consumer",
      );
      expect(consumerEdge).toBeDefined();
      expect(consumerEdge!.target).toBe("notifications");
      expect(consumerEdge!.metadata?.detail).toContain("@Processor");
    });

    it("detects extends WorkerService pattern", () => {
      const source = `
class MyConsumer extends StandardWorkerService<Job> {
  async process(job: Job) {}
}`;
      const input = makeInput([{ path: "worker.ts", source }]);
      const edges = extractServiceTopology(input);

      const consumerEdge = edges.find(
        (e) => e.metadata?.protocol === "queue" && e.metadata?.role === "consumer",
      );
      expect(consumerEdge).toBeDefined();
      expect(consumerEdge!.metadata?.detail).toContain("extends");
    });

    it("detects @Process decorator", () => {
      const source = `
@Process('send-email')
async handleEmail(job: Job) {}`;
      const input = makeInput([{ path: "handler.ts", source }]);
      const edges = extractServiceTopology(input);

      const consumerEdge = edges.find(
        (e) => e.metadata?.protocol === "queue" && e.metadata?.role === "consumer",
      );
      expect(consumerEdge).toBeDefined();
      expect(consumerEdge!.metadata?.detail).toContain("@Process");
      expect(consumerEdge!.metadata?.detail).toContain("send-email");
    });

    it("detects initWorker() calls", () => {
      const source = `
class Scheduler {
  setup() {
    this.worker.initWorker('email-queue');
  }
}`;
      const input = makeInput([{ path: "scheduler.ts", source }]);
      const edges = extractServiceTopology(input);

      const consumerEdge = edges.find(
        (e) => e.metadata?.protocol === "queue" && e.metadata?.role === "consumer",
      );
      expect(consumerEdge).toBeDefined();
      expect(consumerEdge!.target).toBe("email-queue");
    });

    describe("custom queue framework patterns", () => {
      const customFrameworks = [{
        importTrigger: "my-queue-lib",
        producers: [{ memberObject: "MyQueues" }],
        consumers: [
          { classProperty: "queueName" },
          { methodCall: "subscribeFromListeners", target: "event-bus" },
        ],
      }];

      it("detects classProperty consumer with matching import", () => {
        const source = `
class ReminderHandler {
  readonly queueName = 'ReminderFailures';
  async handle(context) {}
}`;
        const input = makeInput([
          { path: "handler.ts", source, imports: ["my-queue-lib"] },
        ]);
        const edges = extractServiceTopology({ ...input, customQueueFrameworks: customFrameworks });
        const consumerEdge = edges.find(
          (e) => e.metadata?.protocol === "queue" && e.metadata?.role === "consumer",
        );
        expect(consumerEdge).toBeDefined();
        expect(consumerEdge!.target).toBe("ReminderFailures");
        expect(consumerEdge!.metadata?.detail).toContain("queueName");
      });

      it("detects methodCall consumer with matching import", () => {
        const source = `
const sf = new lib.serverFramework();
sf.subscribeFromListeners(listeners);`;
        const input = makeInput([
          { path: "server.ts", source, imports: ["my-queue-lib"] },
        ]);
        const edges = extractServiceTopology({ ...input, customQueueFrameworks: customFrameworks });
        const consumerEdge = edges.find(
          (e) => e.metadata?.protocol === "queue" && e.metadata?.role === "consumer",
        );
        expect(consumerEdge).toBeDefined();
        expect(consumerEdge!.target).toBe("event-bus");
        expect(consumerEdge!.metadata?.detail).toContain("subscribeFromListeners");
      });

      it("ignores classProperty consumer without matching import", () => {
        const source = `
class SomeHandler {
  readonly queueName = 'TestQueue';
}`;
        const input = makeInput([{ path: "no-import.ts", source }]);
        const edges = extractServiceTopology({ ...input, customQueueFrameworks: customFrameworks });
        const consumerEdge = edges.find(
          (e) =>
            e.metadata?.protocol === "queue" &&
            e.metadata?.role === "consumer" &&
            (e.metadata?.detail as string)?.includes("queueName"),
        );
        expect(consumerEdge).toBeUndefined();
      });

      it("deduplicates consumer with both methodCall and classProperty", () => {
        const combinedFrameworks = [{
          importTrigger: "my-queue-lib",
          producers: [],
          consumers: [
            { methodCall: "subscribeFromListeners", classProperty: "queueName", target: "fallback-queue" },
          ],
        }];
        const source = `
class MyHandler {
  readonly queueName = 'ActualQueue';
  async subscribeFromListeners() {}
}`;
        const input = makeInput([
          { path: "handler.ts", source, imports: ["my-queue-lib"] },
        ]);
        const edges = extractServiceTopology({ ...input, customQueueFrameworks: combinedFrameworks });
        const consumerEdges = edges.filter(
          (e) => e.metadata?.protocol === "queue" && e.metadata?.role === "consumer",
        );
        expect(consumerEdges).toHaveLength(1);
        expect(consumerEdges[0]!.target).toBe("ActualQueue");
      });
    });
  });

  describe("HTTP clients", () => {
    it("detects fetch() calls", () => {
      const source = `
async function getUser() {
  const res = await fetch('https://api.example.com/users');
  return res.json();
}`;
      const input = makeInput([{ path: "api.ts", source }]);
      const edges = extractServiceTopology(input);

      const httpEdge = edges.find((e) => e.metadata?.protocol === "http");
      expect(httpEdge).toBeDefined();
      expect(httpEdge!.target).toBe("https://api.example.com/users");
      expect(httpEdge!.metadata?.detail).toBe("fetch()");
    });

    it("detects axios.get() with import", () => {
      const source = `
async function getUser() {
  const res = await axios.get('/api/users');
}`;
      const input = makeInput([
        { path: "client.ts", source, imports: ["axios"] },
      ]);
      const edges = extractServiceTopology(input);

      const httpEdge = edges.find((e) => e.metadata?.protocol === "http");
      expect(httpEdge).toBeDefined();
      expect(httpEdge!.metadata?.detail).toBe("axios.get()");
    });

    it("ignores axios-like calls without import", () => {
      const source = `
const result = axios.get('/api/data');`;
      const input = makeInput([{ path: "no-import.ts", source }]);
      const edges = extractServiceTopology(input);

      const httpEdge = edges.find((e) => e.metadata?.protocol === "http");
      expect(httpEdge).toBeUndefined();
    });

    it("detects HttpService (NestJS) calls", () => {
      const source = `
class ApiClient {
  constructor(private httpService: HttpService) {}
  async fetch() {
    return this.httpService.get('/api/data');
  }
}`;
      const input = makeInput([
        { path: "nestjs-client.ts", source, imports: ["@nestjs/axios"] },
      ]);
      const edges = extractServiceTopology(input);

      const httpEdge = edges.find((e) => e.metadata?.protocol === "http");
      expect(httpEdge).toBeDefined();
      expect(httpEdge!.metadata?.detail).toContain("HttpService");
    });
  });

  describe("WebSocket detection", () => {
    it("detects @WebSocketGateway() decorator", () => {
      const source = `
@WebSocketGateway()
class WsGateway {
  handleConnection(client: Socket) {}
}`;
      const input = makeInput([
        { path: "gateway.ts", source, imports: ["@nestjs/websockets"] },
      ]);
      const edges = extractServiceTopology(input);

      const wsEdge = edges.find(
        (e) => e.metadata?.protocol === "websocket" && e.metadata?.role === "server",
      );
      expect(wsEdge).toBeDefined();
      expect(wsEdge!.metadata?.detail).toContain("@WebSocketGateway");
    });

    it("detects @SubscribeMessage decorator", () => {
      const source = `
@SubscribeMessage('widget_updated')
handleWidgetUpdate(client: Socket, data: any) {}`;
      const input = makeInput([
        { path: "ws-handler.ts", source, imports: ["@nestjs/websockets"] },
      ]);
      const edges = extractServiceTopology(input);

      const wsEdge = edges.find(
        (e) =>
          e.metadata?.protocol === "websocket" &&
          e.metadata?.role === "server" &&
          (e.metadata?.detail as string).includes("SubscribeMessage"),
      );
      expect(wsEdge).toBeDefined();
      expect(wsEdge!.target).toBe("widget_updated");
    });

    it("detects socket.emit() with socket.io-client import", () => {
      const source = `
const socket = io('http://localhost:3000');
socket.emit('join', { room: 'test' });
socket.on('message', (data) => console.log(data));`;
      const input = makeInput([
        { path: "ws-client.ts", source, imports: ["socket.io-client"] },
      ]);
      const edges = extractServiceTopology(input);

      const emitEdge = edges.find(
        (e) =>
          e.metadata?.protocol === "websocket" &&
          e.metadata?.role === "client" &&
          (e.metadata?.detail as string).includes("emit"),
      );
      expect(emitEdge).toBeDefined();
      expect(emitEdge!.target).toBe("join");

      const onEdge = edges.find(
        (e) =>
          e.metadata?.protocol === "websocket" &&
          e.metadata?.role === "client" &&
          (e.metadata?.detail as string).includes(".on"),
      );
      expect(onEdge).toBeDefined();
      expect(onEdge!.target).toBe("message");
    });

    it("ignores socket-like calls without socket.io-client import", () => {
      const source = `
socket.emit('event', data);`;
      const input = makeInput([{ path: "no-import.ts", source }]);
      const edges = extractServiceTopology(input);

      const wsEdge = edges.find((e) => e.metadata?.protocol === "websocket");
      expect(wsEdge).toBeUndefined();
    });

    it("ignores NestJS decorators without @nestjs/websockets import", () => {
      const source = `
@WebSocketGateway()
class FakeGateway {}`;
      const input = makeInput([{ path: "no-import.ts", source }]);
      const edges = extractServiceTopology(input);

      const wsEdge = edges.find((e) => e.metadata?.protocol === "websocket");
      expect(wsEdge).toBeUndefined();
    });
  });

  describe("edge metadata", () => {
    it("includes repo in all edge metadata", () => {
      const source = `
async function callApi() { await fetch('/api'); }`;
      const input = makeInput([{ path: "test.ts", source }], "my-repo");
      const edges = extractServiceTopology(input);

      for (const edge of edges) {
        expect(edge.metadata?.repo).toBe("my-repo");
      }
    });

    it("all edges have kind 'service-call'", () => {
      const source = `
@Processor('jobs')
class Worker {}`;
      const input = makeInput([{ path: "w.ts", source }]);
      const edges = extractServiceTopology(input);

      for (const edge of edges) {
        expect(edge.kind).toBe("service-call");
      }
    });

    it("protocol is one of queue, http, websocket", () => {
      const source = `
async function mixed() {
  await fetch('/api');
}
@Processor('tasks')
class TaskWorker {}`;
      const input = makeInput([{ path: "mixed.ts", source }]);
      const edges = extractServiceTopology(input);

      for (const edge of edges) {
        expect(["queue", "http", "websocket"]).toContain(edge.metadata?.protocol);
      }
    });
  });
});
