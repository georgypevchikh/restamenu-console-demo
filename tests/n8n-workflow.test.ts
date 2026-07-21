import { describe, expect, it } from "vitest";
import workflow from "../n8n/restamenu-outbox.json";

type WorkflowNode = {
  name: string;
  type: string;
  parameters: Record<string, unknown>;
};

const nodes = workflow.nodes as WorkflowNode[];
const byName = new Map(nodes.map((node) => [node.name, node]));

describe("Restamenu n8n outbox export", () => {
  it("is an inactive, credential-free template with Header Auth", () => {
    expect(workflow.active).toBe(false);
    expect(JSON.stringify(workflow)).not.toMatch(/service[_-]?role/i);
    expect(JSON.stringify(workflow)).not.toMatch(/eyJ[A-Za-z0-9_-]+\./);
    expect(byName.get("Webhook")?.parameters).toMatchObject({
      authentication: "headerAuth",
      responseMode: "responseNode",
    });
  });

  it("checks a durable delivered-event ledger before Telegram and marks only after send", () => {
    const check = byName.get("Check Delivery Ledger");
    const mark = byName.get("Mark Delivered");
    expect(check?.type).toBe("n8n-nodes-base.code");
    expect(String(check?.parameters.jsCode)).toContain("$getWorkflowStaticData('global')");
    expect(String(check?.parameters.jsCode)).toContain("body.eventId");
    expect(String(mark?.parameters.jsCode)).toContain("delivered[key]");

    expect(workflow.connections["Already Delivered?"].main[0][0].node).toBe(
      "Respond Duplicate",
    );
    expect(workflow.connections["Already Delivered?"].main[1][0].node).toBe(
      "Telegram",
    );
    expect(workflow.connections.Telegram.main[0][0].node).toBe("Mark Delivered");
  });

  it("sends untrusted fields as plain text, not Telegram Markdown", () => {
    const telegram = byName.get("Telegram");
    expect(telegram?.parameters.additionalFields).toEqual({});
    expect(JSON.stringify(telegram)).not.toContain("parse_mode");
    expect(String(telegram?.parameters.text)).toContain("slice(0, 1000)");
  });
});
