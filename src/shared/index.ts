// Shared module barrel: storage layer, local identity, messaging envelope/router
// types, and AppError live here and are imported across every extension context
// (background, content, popup, options). See tasks 4 and 5.
export * from "./messaging";
export * from "./storage";
export * from "./identity";
export * from "./settings";
