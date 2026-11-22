// this file contains all keys for @tanstack/react-query
// basically its a structured way to define query keys
// generally its shaped like this:
// [ entityName, operation, userId, ...otherParams ]
//
// Invalidating `[Entity.x]` (exact: false) refreshes every query of that
// entity, so screens stay in sync without knowing each other's params.

export const Entity = {
    monitor: "monitors",
    monitorRun: "monitor_runs",
    /** One row of `monitor_state` per Monitor (baselines, failure streak). */
    monitorState: "monitor_state",
    /** `changes` rows (lists and single rows). */
    change: "changes",
    capture: "captures",
};

export const Operation = {
    list: "list",
    get: "get",
    save: "save",
    delete: "delete",
    /** The last Runs of one Monitor, for the timeline strip. */
    timeline: "timeline",
};
