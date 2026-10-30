import { TEXT_FILE } from "../tools/file-text.mjs";

export function fileProjects(memory, fileId) {
  return memory.identity
    .projects()
    .filter((p) => p.files.includes(fileId))
    .map(({ id, title, activity, status }) => ({
      id,
      title,
      shared: !!activity,
      status,
    }));
}

export function projectFiles(runtime, agentId, id) {
  const project = runtime.memory.bind(agentId).identity.project(id);
  if (!project) throw Error("RECORD_NOT_FOUND");
  const files = project.files.map((fileId) => {
    try {
      const m = runtime.files.metadata(agentId, fileId);
      if (!m) throw Error("FILE_NOT_FOUND");
      return {
        fileId,
        name: m.name,
        bytes: m.bytes,
        createdAt: m.createdAt,
        readable: TEXT_FILE.test(m.name),
      };
    } catch {
      return {
        fileId,
        name: "文件暂不可用",
        readable: false,
        unavailable: true,
      };
    }
  });
  return { project, files };
}
