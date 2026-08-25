window.__ModuleLoader__.load({
	id: "dsh-verify-reflux",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const h = react.createElement;

		//#region parsing ------------------------------------------------------
		/** Pull every text block out of a settled tool result's content array. */
		function resultText(block) {
			try {
				return (block.content || [])
					.map((b) => (b && typeof b.text === "string" ? b.text : ""))
					.join("\n")
					.trim();
			} catch {
				return "";
			}
		}

		/** Parse the `Best:` headline and the <verified_decision> provenance block. */
		function parseReflux(text) {
			if (!text) return null;
			const bestLine = (text.match(/^Best:[^\n]*/m) || [null])[0];
			const dec = text.match(/<verified_decision([^>]*)>([\s\S]*?)<\/verified_decision>/);
			let attrs = null;
			let inner = [];
			if (dec) {
				attrs = {};
				const re = /(\w+)="([^"]*)"/g;
				let m;
				while ((m = re.exec(dec[1]))) attrs[m[1]] = m[2];
				inner = dec[2]
					.split("\n")
					.map((s) => s.trim())
					.filter(Boolean);
			}
			if (!bestLine && !attrs) return null;
			return { bestLine, attrs, inner };
		}
		//#endregion

		//#region styling ------------------------------------------------------
		const PALETTE = {
			accent: "#7c6cff",
			dim: "#8b8fa3",
			border: "#ffffff22",
			cardBg: "#ffffff08",
			chipBg: "#7c6cff1f",
			pre: "#c9cdf5",
		};
		const styles = {
			details: {
				border: `1px solid ${PALETTE.border}`,
				borderRadius: 10,
				background: PALETTE.cardBg,
				margin: "2px 0",
				overflow: "hidden",
			},
			summary: {
				display: "flex",
				alignItems: "center",
				gap: 8,
				padding: "7px 12px",
				cursor: "pointer",
				listStyle: "none",
				userSelect: "none",
				fontSize: 12.5,
			},
			icon: { color: PALETTE.accent, flexShrink: 0 },
			title: { fontWeight: 600, letterSpacing: 0.2 },
			subtitle: { color: PALETTE.dim, fontSize: 11.5 },
			chip: {
				background: PALETTE.chipBg,
				color: PALETTE.accent,
				borderRadius: 999,
				padding: "1px 9px",
				fontSize: 11,
				fontWeight: 600,
				whiteSpace: "nowrap",
			},
			body: { padding: "4px 12px 10px", borderTop: `1px solid ${PALETTE.border}` },
			best: { fontSize: 12.5, fontWeight: 600, margin: "8px 0 4px" },
			line: { fontSize: 12, margin: "3px 0", lineHeight: 1.45 },
			attrRow: { display: "flex", flexWrap: "wrap", gap: 6, margin: "6px 0" },
			attr: {
				fontSize: 10.5,
				color: PALETTE.dim,
				border: `1px solid ${PALETTE.border}`,
				borderRadius: 5,
				padding: "1px 6px",
			},
			pre: {
				margin: "8px 0 0",
				padding: "8px 10px",
				background: "#00000030",
				borderRadius: 8,
				fontSize: 11,
				lineHeight: 1.5,
				color: PALETTE.pre,
				whiteSpace: "pre-wrap",
				wordBreak: "break-word",
				maxHeight: 260,
				overflowY: "auto",
			},
			rawToggle: {
				marginTop: 8,
				fontSize: 11,
				color: PALETTE.dim,
				cursor: "pointer",
				background: "none",
				border: "none",
				padding: 0,
			},
			error: { color: "#ff7a7a", fontSize: 12 },
			card: {
				border: `1px solid ${PALETTE.border}`,
				borderRadius: 10,
				background: PALETTE.cardBg,
				padding: "12px 14px",
				display: "flex",
				flexDirection: "column",
				gap: 10,
			},
			cardTitle: { fontSize: 13.5, fontWeight: 700 },
			cardDesc: { fontSize: 11.5, color: PALETTE.dim, margin: 0, lineHeight: 1.5 },
			fieldRow: { display: "flex", flexDirection: "column", gap: 4 },
			label: { fontSize: 12, fontWeight: 600 },
			hint: { fontSize: 11, color: PALETTE.dim, lineHeight: 1.45 },
			radioRow: { display: "flex", gap: 14, flexWrap: "wrap" },
			radioLabel: { display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, cursor: "pointer" },
			checkRow: { display: "flex", alignItems: "flex-start", gap: 7 },
			flash: { fontSize: 11, color: "#6fd18a", minHeight: 14 },
		};
		//#endregion

		//#region verdict card -------------------------------------------------
		const TOOL_META = {
			verify_select: { title: "概率验证 · 选优", icon: "⚖" },
			verify_check: { title: "概率验证 · 风险地图", icon: "🛡" },
			verify_track: { title: "概率验证 · 进度", icon: "📈" },
		};

		function AttrBadges({ attrs }) {
			if (!attrs) return null;
			const keep = ["via", "model", "seed", "margin", "tool"];
			return h(
				"div",
				{ style: styles.attrRow },
				keep.filter((k) => attrs[k]).map((k) =>
					h("span", { key: k, style: styles.attr }, `${k}=${attrs[k]}`),
				),
			);
		}

		function RawSection({ text }) {
			const [open, setOpen] = react.useState(false);
			if (!text) return null;
			return h(
				"div",
				null,
				h(
					"button",
					{ style: styles.rawToggle, onClick: () => setOpen(!open) },
					open ? "▾ 收起原始输出" : "▸ 原始输出",
				),
				open && h("pre", { style: styles.pre }, text),
			);
		}

		function VerifyCard(props) {
			const { block } = props || {};
			const meta = TOOL_META[(props && props.toolName) || ""] || { title: "概率验证", icon: "⚡" };
			const text = resultText(block || {});
			const parsed = parseReflux(text);
			const isError = !!(block && block.isError);

			let chip = null;
			if (isError) chip = h("span", { style: { ...styles.chip, color: "#ff7a7a", background: "#ff7a7a1f" } }, "失败");
			else if (parsed && parsed.bestLine) chip = h("span", { style: styles.chip }, parsed.bestLine.replace(/^Best:\s*/, "").slice(0, 40));
			else if (parsed && parsed.attrs && parsed.attrs.margin !== undefined) chip = h("span", { style: styles.chip }, `margin ${parsed.attrs.margin}`);
			else if (text) chip = h("span", { style: styles.chip }, text.split("\n")[0].slice(0, 36));

			return h(
				"details",
				{ style: styles.details },
				h(
					"summary",
					{ style: styles.summary },
					h("span", { style: styles.icon }, meta.icon),
					h("span", { style: styles.title }, meta.title),
					h(
						"span",
						{ style: { ...styles.subtitle, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
						parsed && parsed.attrs && parsed.attrs.via ? parsed.attrs.via : "tiered judge",
					),
					chip,
				),
				h(
					"div",
					{ style: styles.body },
					isError && h("div", { style: styles.error }, text || "verification failed"),
					!isError && parsed && parsed.bestLine && h("div", { style: styles.best }, parsed.bestLine),
					!isError && h(AttrBadges, { attrs: parsed && parsed.attrs }),
					!isError &&
						parsed &&
						parsed.inner.map((line, i) => h("div", { key: i, style: styles.line }, line)),
					!isError && !parsed && text && h("pre", { style: styles.pre }, text),
					h(RawSection, { text }),
				),
			);
		}
		//#endregion

		//#region settings card ------------------------------------------------
		const NS_SETTINGS = "verify-reflux";
		const TIERS = [
			{ value: "off", label: "关闭", hint: "不注入任何预轮内容" },
			{ value: "light", label: "Light", hint: "零延迟：注入既有裁决快照与勿重试清单（仅限跑过验证的会话，除非勾选全域）" },
			{ value: "full", label: "Full", hint: "主模型等待验证器补全产出 ≤3 条风险清单后再生成；失手自动降级 Light" },
		];

		function useBoundSnapshot(bound) {
			const [snap, setSnap] = react.useState(() => bound.getSnapshot());
			react.useEffect(() => {
				let alive = true;
				const off = bound.subscribe(() => {
					if (alive) setSnap(bound.getSnapshot());
				});
				return () => {
					alive = false;
					off();
				};
			}, [bound]);
			return snap;
		}

		/**
		 * 设置 → 插件配置 的配置卡，键控于本插件命名空间。
		 * 写入直走绑定作用域的 revision-fenced set()；两个字段不值得自建暂存区。
		 */
		function VerifyConfigCard({ scope }) {
			const snap = useBoundSnapshot(scope);
			const [flash, setFlash] = react.useState("");
			const value = snap.value || {};
			const writable = !!snap.writable;

			const change = (field, v) => {
				scope
					.set(field, v)
					.then(() => {
						setFlash("已保存 ✓");
						setTimeout(() => setFlash(""), 1600);
					})
					.catch(() => setFlash("保存失败，请重试"));
			};

			return h(
				"div",
				{ style: styles.card },
				h("div", { style: styles.cardTitle }, "⚖ 概率验证器"),
				h(
					"p",
					{ style: styles.cardDesc },
					"判分档位与预轮 DeepThink。修改即时持久化，无需重启。",
				),
				h(
					"div",
					{ style: styles.fieldRow },
					h("div", { style: styles.label }, "预轮 DeepThink 档位"),
					h(
						"div",
						{ style: styles.radioRow },
						TIERS.map((t) =>
							h(
								"label",
								{ key: t.value, style: styles.radioLabel },
								h("input", {
									type: "radio",
									name: "verify-reflux-tier",
									disabled: !writable,
									checked: (value.preTurnDeepThink || "off") === t.value,
									onChange: () => change("preTurnDeepThink", t.value),
								}),
								t.label,
							),
						),
					),
					h(
						"span",
						{ style: styles.hint },
						(TIERS.find((t) => (value.preTurnDeepThink || "off") === t.value) || TIERS[0]).hint,
					),
				),
				h(
					"label",
					{ style: styles.checkRow },
					h("input", {
						type: "checkbox",
						disabled: !writable,
						checked: !!value.preTurnEverywhere,
						onChange: (e) => change("preTurnEverywhere", e.target.checked),
					}),
					h(
						"span",
						null,
						h("div", { style: styles.label }, "作用于全部会话"),
						h(
							"span",
							{ style: styles.hint },
							"默认仅限跑过验证的会话；勾选后所有对话都做预轮注入（谨慎）。",
						),
					),
				),
				snap.status === "unavailable" &&
					h("span", { style: styles.hint }, "当前部署不可写设置（memory 模式），仅作展示。"),
				h("span", { style: styles.flash }, flash),
			);
		}
		//#endregion

		//#region apply --------------------------------------------------------
		const inject = ["slots", "settingsScope"];
		const KEYS = ["verify_select", "verify_check", "verify_track"];

		/**
		 * Client plugin body: keyed atomic Tool views for the three wire tools
		 * (additive — unclaimed keys keep the generic card), plus this plugin's
		 * configuration card keyed by its settings namespace.
		 */
		function apply(ctx) {
			ctx.slots.inject("tool.call.toolview", function* () {
				for (const key of KEYS) {
					yield ctx.slots.register({ name: "tool.call.toolview", key }, VerifyCard);
				}
			});
			try {
				const bound = ctx.settingsScope.bind({ namespace: NS_SETTINGS });
				ctx.slots.inject("settings.plugin.item", function* () {
					yield ctx.slots.register(
						{ name: "settings.plugin.item", key: NS_SETTINGS },
						function CardHost() {
							return h(VerifyConfigCard, { scope: bound });
						},
					);
				});
			} catch {
				// settings 服务缺席时仅少一张配置卡，工具视图不受影响。
			}
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
