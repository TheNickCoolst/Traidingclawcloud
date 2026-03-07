import { registerTool } from "./index.js";
import { addMemory, searchMemories, deleteMemory } from "../db.js";
import { addEntity, addRelation, queryGraph, traverseGraph } from "../memory/knowledge-graph.js";

// Tool 1: Store Memory
registerTool(
    "store_memory",
    "Save an important fact, user preference, or project context for long-term retrieval.",
    {
        type: "object",
        properties: {
            content: {
                type: "string",
                description: "The information to remember (e.g. 'User likes dark mode', 'Target audience is crypto traders')",
            },
        },
        required: ["content"],
    },
    async (input) => {
        const content = input.content as string;
        const id = addMemory(content);
        return `Memory stored successfully with ID ${id}.`;
    }
);

// Tool 2: Search Memory
registerTool(
    "search_memory",
    "Search long-term memory using keywords. Use this when you lack context about the user or project.",
    {
        type: "object",
        properties: {
            query: {
                type: "string",
                description: "Keywords to search for (e.g. 'theme preference', 'project goals')",
            },
        },
        required: ["query"],
    },
    async (input) => {
        const query = input.query as string;
        const results = searchMemories(query);

        if (results.length === 0) {
            return `No memories found matching "${query}".`;
        }

        const formatted = results
            .map((m) => `[ID: ${m.id} | ${m.created_at}] ${m.content}`)
            .join("\n");

        return `Found ${results.length} relevant memories:\n${formatted}`;
    }
);

// Tool 3: Delete Memory
registerTool(
    "delete_memory",
    "Remove an outdated or incorrect memory by its ID.",
    {
        type: "object",
        properties: {
            id: {
                type: "number",
                description: "The numeric ID of the memory to delete (found via search_memory)",
            },
        },
        required: ["id"],
    },
    async (input) => {
        const id = input.id as number;
        const success = deleteMemory(id);
        if (success) {
            return `Memory ${id} successfully deleted.`;
        } else {
            return `Failed to delete. Memory ID ${id} not found.`;
        }
    }
);

// ── Knowledge Graph Tools ────────────────────────────────────────────────────

// Tool 4: Add KG Entity
registerTool(
    "kg_add_entity",
    "Add a structured entity (person, place, concept) to the Knowledge Graph.",
    {
        type: "object",
        properties: {
            id: { type: "string", description: "Unique identifier (lowercase, no spaces, e.g. 'john_doe')" },
            label: { type: "string", description: "Human-readable label (e.g. 'John Doe')" },
            type: { type: "string", description: "Node type (e.g. 'person', 'concept')" },
        },
        required: ["id", "label", "type"],
    },
    async (input) => addEntity(input.id as string, input.label as string, input.type as string)
);

// Tool 5: Add KG Relation
registerTool(
    "kg_add_relation",
    "Add a directed edge/relationship between two exiting entities in the Knowledge Graph.",
    {
        type: "object",
        properties: {
            sourceId: { type: "string", description: "Source node ID" },
            targetId: { type: "string", description: "Target node ID" },
            label: { type: "string", description: "Relationship verb/label (e.g. 'LIKES', 'KNOWS_ABOUT', 'WORKS_AT')" }
        },
        required: ["sourceId", "targetId", "label"],
    },
    async (input) => addRelation(input.sourceId as string, input.targetId as string, input.label as string)
);

// Tool 6: Query KG
registerTool(
    "kg_query",
    "Search the Knowledge Graph for relations connected to a specific entity label.",
    {
        type: "object",
        properties: {
            searchTerm: { type: "string", description: "Label or part of a label to search for." },
        },
        required: ["searchTerm"],
    },
    async (input) => queryGraph(input.searchTerm as string)
);

// Tool 7: Traverse KG
registerTool(
    "kg_traverse",
    "Recursively traverse the Knowledge Graph to find extended relationship paths from a starting concept.",
    {
        type: "object",
        properties: {
            startLabel: { type: "string", description: "The node label to start traversal from" }
        },
        required: ["startLabel"],
    },
    async (input) => traverseGraph(input.startLabel as string)
);
