export type AgentSoul={provider:string;model:string;routingClass?:"system_one"|"system_two"};
export type AgentBody={bodyId:string;version:number;role:string;capabilities:string[];tools:string[];permissions:string[]};
export type AgentInstance={body:AgentBody;soul:AgentSoul};
export function possess(body:AgentBody,soul:AgentSoul):AgentInstance{return{body,soul}};