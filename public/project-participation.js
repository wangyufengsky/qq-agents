function bindProjectParticipation(root, agentId, p, files, active) {
  if (["done", "dropped"].includes(p.status)) {
    root.innerHTML = '<p class="hint">项目已结束，原稿和参与记录仍可阅读。</p>';
    return;
  }
  const joined = p.activity?.participants.includes("administrator");
  const mayEdit =
    !p.activity || ["agent", "administrator"].includes(p.activity.turn);
  root.innerHTML = !joined
    ? `<form data-participate="join" class="project-participate"><p>${p.activity ? "明确加入后，你可以以管理员身份留下建议和共同改稿。" : "加入后，此个人项目成为你和角色的共同活动。既有文件和个人进展保留原样。"}</p>${!p.activity ? select("sourceFileId", "作为共写原稿的文件", "", [["", "暂不导入原稿"], ...files.filter((f) => f.readable).map((f) => [f.fileId, f.name])]) : ""}<button>${p.activity ? "加入活动" : "加入并转为共同活动"}</button><p data-participation-result role="status"></p></form>`
    : `<p class="hint">你已以管理员身份参与。提交会形成可追溯的新修订，角色下次查看此项目时可读；运行与暂停设置仍然生效。</p><form data-participate="comment" class="project-participate"><label>给这个活动的建议<textarea name="text" required maxlength="4000" rows="3" placeholder="写下你的想法，保留为管理员原始贡献"></textarea></label><button>提交建议</button><p data-participation-result role="status"></p></form>${
        mayEdit && p.activity.pending.length
          ? `<form data-participate="decision" class="project-participate">${select(
              "choiceId",
              "回应待定事项",
              p.activity.pending[0].id,
              p.activity.pending.map((c) => [c.id, c.question]),
            )}<label>已有选项<select data-choice-options><option value="">自行填写回应</option></select></label><label>你的回应<textarea name="text" required maxlength="2000" rows="2"></textarea></label><button>保存回应</button><p data-participation-result role="status"></p></form>`
          : ""
      }${mayEdit ? '<details class="project-participate"><summary>共同修改原稿</summary><button type="button" data-load-project-editor>读取当前原稿开始修改</button><div data-project-editor></div></details>' : `<p class="hint">当前轮到 ${esc(projectActor(p.activity.turn))}。可以留下建议；回应和改稿等待该参与者完成当前轮次。</p>`}`;
  let pendingSubmission,
    busy = false,
    reading = false;
  const baselines = new WeakMap();
  const snapshot = (form) => JSON.stringify([...new FormData(form)]);
  const submit = async (form, values) => {
    if (busy) return;
    if (reading) {
      form.querySelector("[data-participation-result]").textContent =
        "正在读取原稿，读完后即可提交。";
      return;
    }
    const submitted = snapshot(form);
    const dirtyOthers = [
      ...root.querySelectorAll("form[data-participate]"),
    ].some(
      (other) => other !== form && snapshot(other) !== baselines.get(other),
    );
    const controls = [
      ...root.querySelectorAll("button,input,textarea,select"),
    ].map((element) => [element, element.disabled]);
    const restoreControls = () =>
      controls.forEach(([element, disabled]) => {
        if (element.isConnected) element.disabled = disabled;
      });
    const payload = {
      agentId,
      id: p.id,
      expectedRevision: p.revision,
      ...values,
    };
    const signature = JSON.stringify(payload);
    if (pendingSubmission?.signature !== signature)
      pendingSubmission = { signature, submissionId: crypto.randomUUID() };
    const output = form.querySelector("[data-participation-result]");
    busy = true;
    controls.forEach(([element]) => {
      element.disabled = true;
    });
    output.textContent = "正在保存…";
    try {
      const result = await api("/api/project/participate", {
        ...payload,
        submissionId: pendingSubmission.submissionId,
      });
      if (!active()) return;
      restoreControls();
      const changedDuringSave = snapshot(form) !== submitted;
      if (dirtyOthers || changedDuringSave) {
        // Only rebase other edits over our own confirmed write. An idempotent
        // retry may return a newer project whose changes we have not read.
        const current = result.project.revision === result.savedRevision;
        if (current) p = result.project;
        if (!changedDuringSave) {
          if (values.action !== "draft") form.elements.text.value = "";
          if (values.action === "decision")
            form.querySelectorAll("label,button").forEach((element) => {
              element.hidden = true;
            });
          baselines.set(form, snapshot(form));
        }
        output.textContent = `已保存为修订 ${result.savedRevision}。其他未提交输入已保留；${current ? "完成编辑后可刷新查看历史。" : "项目已有后续修订，请复制输入并刷新核对。"}`;
        return;
      }
      await renderProjects();
    } catch (error) {
      if (!active()) return;
      const messages = {
        REVISION_CONFLICT:
          "项目已有新修订。你的输入仍保留在这里，请先复制文字，再刷新查看新稿后提交。",
        ACTIVITY_CONTRIBUTIONS_PENDING:
          "尚有较多贡献等待角色查看。已填写文字仍保留，请稍后再提交。",
        ACTIVITY_WAITING_FOR_PARTICIPANT:
          "当前正在等另一位参与者，不能替其推进。",
        ACTIVITY_DRAFT_TOO_LONG:
          "所选文件超过 32000 字符，请先选择较短的共写原稿。",
        RECALL_SOURCE_NOT_ALLOWED:
          "此文件包含受保护来源，不能转入普通共同活动。",
      };
      output.textContent = messages[error.code] || error.message;
    } finally {
      busy = false;
      restoreControls();
    }
  };
  const bind = (form) => {
    baselines.set(form, snapshot(form));
    form.onsubmit = (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(form));
      if (values.sourceFileId === "") delete values.sourceFileId;
      submit(form, { action: form.dataset.participate, ...values });
    };
  };
  root.querySelectorAll("form[data-participate]").forEach(bind);
  const decision = root.querySelector('[data-participate="decision"]');
  if (decision) {
    const choices = decision.elements.choiceId,
      options = decision.querySelector("[data-choice-options]");
    const updateOptions = () => {
      const choice = p.activity.pending.find((c) => c.id === choices.value);
      options.innerHTML =
        '<option value="">自行填写回应</option>' +
        choice.options
          .map((x) => `<option value="${esc(x)}">${esc(x)}</option>`)
          .join("");
      decision.elements.text.value = "";
    };
    choices.onchange = updateOptions;
    options.onchange = () => {
      decision.elements.text.value = options.value;
    };
    updateOptions();
  }
  const editor = root.querySelector("[data-load-project-editor]");
  if (editor)
    editor.onclick = () =>
      action(async () => {
        if (busy || reading) return;
        reading = true;
        editor.disabled = true;
        try {
          let offset = 0,
            text = "",
            title = p.title;
          do {
            const result = await api(
              "/api/project?" +
                new URLSearchParams({
                  agentId,
                  id: p.id,
                  revision: p.revision,
                  offset,
                }),
            );
            if (!active()) return;
            if (result.draft) {
              title = result.draft.title;
              text += result.draft.text;
            }
            offset = result.draft?.nextOffset ?? null;
          } while (offset !== null);
          const target = root.querySelector("[data-project-editor]");
          target.innerHTML = `<form data-participate="draft"><label>原稿标题<input name="title" required maxlength="100" value="${esc(title)}"></label><label>原稿全文<textarea name="text" maxlength="32000" rows="16"></textarea></label><p class="hint">保存为管理员编写的新修订，旧稿和来源文件继续保留。</p><button>保存新修订</button><p data-participation-result role="status"></p></form>`;
          target.querySelector("textarea").value = text;
          bind(target.querySelector("form"));
          editor.hidden = true;
        } finally {
          reading = false;
          if (editor.isConnected) editor.disabled = false;
        }
      });
}
