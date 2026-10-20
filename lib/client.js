window.__ModuleLoader__.load({
	id: "dsh-session-leftover-purge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const { jsx, jsxs } = require("react/jsx-runtime");
		const React = require("react");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		/** 设置命名空间 = cordis.patch.yml 里本插件的组合条目 id。 */
		const NS = "session-leftover-purge";

		/** 与 lib/schema.js 的 .default(...) 保持一致；恢复默认按这张表回填。 */
		const DEFAULTS = {
			enabled: true,
			biliJson: true,
			biliIndexDb: true,
			costMeterLedger: false,
			dryRun: false,
			reconcileOnBoot: true,
			autoPurgeOrphans: false,
			bootDelayMs: 8000,
			restoreBackupTrigger: 0,
			deleteBackupsTrigger: 0,
			backupLedgerTrigger: 0,
		};

		const BOOLS = [
			{ key: "enabled", label: "总开关", hint: "关闭后不再监听会话删除事件，也不做开机对账" },
			{ key: "biliJson", label: "清理 bili JSON 快照", hint: "删除会话时移除 billion-context 的 JSON 快照（bili 面板里列出的那一条）" },
			{ key: "biliIndexDb", label: "清理 bili SQLite 索引", hint: "同时从 bili 的 index.db 删掉该会话；清理前自动完整备份，可回滚" },
			{ key: "costMeterLedger", label: "清理 cost-meter 账本明细", hint: "只删该会话的明细行，不动当日总额——那笔钱确实花过" },
			{ key: "costMeterFiles", label: "清理 cost-meter 原始明细文件", hint: "删 groups/streams/calls 里属于该会话的文件。不影响任何总额，但会丢掉「哪一轮花了多少」的凭证" },
			{ key: "vacuumIndexDb", label: "开机回收 index.db 空间", hint: "VACUUM + WAL 截断，把已删行占用的字节真正抹掉。需要独占锁，拿不到就跳过；失败会回滚" },
			{ key: "dryRun", label: "演练模式", hint: "只在 purge.log 里记录将要做什么，不移动也不删除任何文件" },
			{ key: "reconcileOnBoot", label: "开机对账", hint: "启动时扫描一遍孤儿快照；默认开启" },
			{ key: "autoPurgeOrphans", label: "自动清理孤儿", hint: "开机对账发现孤儿时自动清理，而不是只登记到 orphans.json" },
		];

		const NUMBERS = [
			{ key: "trashRetentionDays", label: "备份保留天数", hint: "超过即在下次启动时删除；0 表示永久保留", min: 0 },
			{ key: "bootDelayMs", label: "开机延迟（毫秒）", hint: "启动后等多久再对账，留出 transcript 落盘时间", min: 0 },
			{ key: "restoreBackupTrigger", label: "恢复最近备份", hint: "填一个新数字并保存 = 恢复最近一批 index.db 备份", min: 0 },
			{ key: "deleteBackupsTrigger", label: "删除全部备份", hint: "填一个新数字并保存 = 清空 trash 里的全部批次", min: 0 },
			{ key: "backupLedgerTrigger", label: "立即备份账本", hint: "填一个新数字并保存 = 立刻给 cost-meter 账本拍一份快照", min: 0 },
		];

		const ALL_KEYS = [...BOOLS.map((f) => f.key), ...NUMBERS.map((f) => f.key)];
		/** 恢复默认只回填开关与延迟，不碰三个触发器（否则会意外触发一次恢复/删除）。 */
		const RESETTABLE = [...BOOLS.map((f) => f.key), "bootDelayMs"];

		const labelStyle = { fontSize: 14, lineHeight: 1.5 };
		const hintStyle = { fontSize: 12, opacity: 0.62, marginTop: 2, lineHeight: 1.6 };
		const rowStyle = {
			display: "flex",
			alignItems: "center",
			gap: 16,
			padding: "10px 0",
			borderBottom: "1px solid rgba(128,128,128,.18)",
		};
		const inputStyle = {
			width: 140,
			padding: "6px 10px",
			fontSize: 14,
			borderRadius: 8,
			border: "1px solid rgba(128,128,128,.35)",
			background: "transparent",
			color: "inherit",
			outline: "none",
		};
		const buttonStyle = {
			padding: "7px 18px",
			fontSize: 13,
			borderRadius: 8,
			border: "1px solid rgba(128,128,128,.4)",
			background: "transparent",
			color: "inherit",
			cursor: "pointer",
		};
		const primaryStyle = {
			...buttonStyle,
			background: "#4d6bfe",
			borderColor: "#4d6bfe",
			color: "#fff",
		};

		/** 一个布尔行：左标题右开关。 */
		function BoolRow(props) {
			const { label, hint, checked, onToggle } = props;
			return jsxs("div", {
				style: rowStyle,
				children: [
					jsxs("div", {
						style: { flex: 1, minWidth: 0 },
						children: [
							jsx("div", { style: labelStyle, children: label }),
							hint ? jsx("div", { style: hintStyle, children: hint }) : null,
						],
					}),
					jsx(primitives.Switch, { checked, label, onChange: onToggle }),
				],
			});
		}

		/** 一个数字行：右对齐输入框，回车或失焦写入草稿。 */
		function NumberRow(props) {
			const { label, hint, value, min, onCommit } = props;
			const [text, setText] = React.useState(value === undefined || value === null ? "" : String(value));
			React.useEffect(() => {
				setText(value === undefined || value === null ? "" : String(value));
			}, [value]);
			const commit = () => {
				const trimmed = text.trim();
				if (trimmed === "") {
					onCommit(undefined);
					return;
				}
				const n = Number(trimmed);
				if (!Number.isFinite(n) || n < (min ?? 0)) {
					setText(value === undefined || value === null ? "" : String(value));
					return;
				}
				if (n !== value) onCommit(n);
			};
			return jsxs("div", {
				style: rowStyle,
				children: [
					jsxs("div", {
						style: { flex: 1, minWidth: 0 },
						children: [
							jsx("div", { style: labelStyle, children: label }),
							hint ? jsx("div", { style: hintStyle, children: hint }) : null,
						],
					}),
					jsx("input", {
						type: "number",
						min: min ?? 0,
						value: text,
						style: inputStyle,
						onChange: (event) => setText(event.target.value),
						onBlur: commit,
						onKeyDown: (event) => {
							if (event.key === "Enter") event.currentTarget.blur();
						},
					}),
				],
			});
		}

		/** 插件管理页里的配置卡：草稿 + 保存 / 恢复默认。 */
		function LeftoverPurgeCard(props) {
			const scope = props.scope;
			const [snapshot, setSnapshot] = React.useState(() => scope.getSnapshot());
			const [draft, setDraft] = React.useState(null);
			const [busy, setBusy] = React.useState(false);
			const [message, setMessage] = React.useState("");
			const [messageIsError, setMessageIsError] = React.useState(false);
			React.useEffect(() => {
				if (typeof scope.subscribe !== "function") return undefined;
				return scope.subscribe(() => setSnapshot(scope.getSnapshot()));
			}, [scope]);

			const saved = (snapshot && snapshot.value) || {};
			const current = draft === null ? saved : draft;
			const changed = draft === null ? [] : ALL_KEYS.filter((key) => draft[key] !== saved[key]);
			const dirty = changed.length > 0;

			const note = (text, isError) => {
				setMessage(text);
				setMessageIsError(isError === true);
			};
			const edit = (key, value) => {
				note("", false);
				setDraft(Object.assign({}, current, { [key]: value }));
			};
			const resetToDefaults = () => {
				note("", false);
				const next = Object.assign({}, current);
				for (const key of RESETTABLE) next[key] = DEFAULTS[key];
				setDraft(next);
			};
			const save = async () => {
				if (!dirty || busy) return;
				setBusy(true);
				note("", false);
				try {
					for (const key of changed) {
						const ok = await scope.set(key, draft[key]);
						if (ok === false) throw new Error(`「${key}」被本部署拒绝`);
					}
					setDraft(null);
					note(`已保存 ${changed.length} 项`, false);
				} catch (error) {
					note(`保存失败：${String(error && error.message ? error.message : error)}`, true);
				} finally {
					setBusy(false);
				}
			};

			return jsxs("div", {
				style: { padding: "4px 0 8px" },
				children: [
					...BOOLS.map((field) =>
						jsx(
							BoolRow,
							{
								label: field.label,
								hint: field.hint,
								checked: current[field.key] === true,
								onToggle: (next) => edit(field.key, next),
							},
							field.key,
						),
					),
					...NUMBERS.map((field) =>
						jsx(
							NumberRow,
							{
								label: field.label,
								hint: field.hint,
								min: field.min,
								value: current[field.key],
								onCommit: (next) => edit(field.key, next),
							},
							field.key,
						),
					),
					jsxs("div", {
						style: { display: "flex", alignItems: "center", gap: 10, marginTop: 16, flexWrap: "wrap" },
						children: [
							jsx("button", {
								type: "button",
								onClick: save,
								disabled: !dirty || busy,
								style: !dirty || busy ? Object.assign({}, primaryStyle, { opacity: 0.45, cursor: "not-allowed" }) : primaryStyle,
								children: busy ? "保存中…" : "保存",
							}),
							jsx("button", {
								type: "button",
								onClick: resetToDefaults,
								disabled: busy,
								style: buttonStyle,
								children: "恢复默认",
							}),
							dirty
								? jsx("span", { style: { fontSize: 12, opacity: 0.65 }, children: `${changed.length} 项未保存` })
								: null,
							message
								? jsx("span", {
										style: { fontSize: 12, color: messageIsError ? "#d9534f" : "#3aa657" },
										children: message,
									})
								: null,
						],
					}),
					jsx("p", {
						style: { fontSize: 12, opacity: 0.55, marginTop: 12, lineHeight: 1.6 },
						children:
							"「恢复默认」只回填开关与延迟，不动三个触发器——把它们清零会真的触发一次恢复或删除。" +
							"触发器字段填一个新数字并保存就执行一次；插件会记住上次执行的值。",
					}),
				],
			});
		}

		const inject = ["slots", "locale", "configForms"];

		function apply(ctx) {
			const scope = ctx.configForms.get(NS);
			ctx.effect(
				() =>
					ctx.configForms.whileServed([NS], () =>
						ctx.slots.inject("plugins.bundle.config", () =>
							ctx.slots.register(
								{
									name: "plugins.bundle.config",
									key: "dsh-session-leftover-purge",
									inject: () => ({ scope }),
								},
								LeftoverPurgeCard,
							),
						),
					),
				"session-leftover-purge: page",
			);
		}

		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
