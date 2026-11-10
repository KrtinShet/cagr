import { resolve } from "node:path";
import type { RunResult } from "../run";
import type { FindingTool } from "./command";
import type { Finding } from "./match";

/** Reject incomplete reports, parser errors and unexplained exit statuses. */
export function parseFindings(
	tool: FindingTool,
	result: RunResult,
	file: string,
): Finding[] | null {
	if (
		result.timedOut ||
		![0, 1].includes(result.exitCode as number) ||
		result.stderr?.trim()
	)
		return null;
	try {
		const data = JSON.parse(result.stdout);
		if (!Array.isArray(data)) return null;
		const findings: Finding[] = [];
		if (tool === "eslint") {
			if (data.length !== 1 || resolve(data[0].filePath) !== resolve(file))
				return null;
			const report = data[0];
			if (
				!Array.isArray(report.messages) ||
				report.fatalErrorCount !== 0 ||
				report.errorCount !==
					report.messages.filter((m: { severity: number }) => m.severity === 2)
						.length ||
				report.warningCount !==
					report.messages.filter((m: { severity: number }) => m.severity === 1)
						.length
			)
				return null;
			for (const m of report.messages) {
				if (
					m.fatal ||
					typeof m.ruleId !== "string" ||
					![1, 2].includes(m.severity)
				)
					return null;
				findings.push({
					code: m.ruleId,
					message: m.message,
					severity: String(m.severity),
					line: m.line,
					endLine: m.endLine ?? m.line,
					column: m.column,
				});
			}
		} else {
			for (const m of data) {
				if (
					resolve(m.filename) !== resolve(file) ||
					typeof m.code !== "string" ||
					!/^[A-Z]+[0-9]+$/.test(m.code) ||
					!["error", "warning"].includes(m.severity ?? "error") ||
					!m.end_location
				)
					return null;
				findings.push({
					code: m.code,
					message: m.message,
					severity: m.severity ?? "error",
					line: m.location.row,
					endLine: m.end_location.row,
					column: m.location.column,
				});
			}
		}
		if (
			findings.some(
				(f) =>
					typeof f.message !== "string" ||
					!Number.isInteger(f.line) ||
					f.line < 1 ||
					!Number.isInteger(f.endLine) ||
					f.endLine < f.line ||
					!Number.isInteger(f.column) ||
					f.column < 1,
			)
		)
			return null;
		if (result.exitCode === 1 && findings.length === 0) return null;
		return findings;
	} catch {
		return null;
	}
}
