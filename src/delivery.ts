/** Completion belongs either to an awaiting tool or to the asynchronous notification. */
export class CompletionDelivery {
	private waiters = 0;
	private consumed = false;
	private delivered = false;
	private finish?: (channel: "tool" | "notice") => void;
	private readonly notifyCompletion: boolean;
	constructor(notifyCompletion: boolean) { this.notifyCompletion = notifyCompletion; }

	claim(): (consumed: boolean) => void {
		this.waiters++;
		let released = false;
		return (consumed) => {
			if (released) return;
			released = true;
			this.waiters--;
			this.consumed ||= consumed;
			this.flush();
		};
	}
	complete(finish: (channel: "tool" | "notice") => void): void {
		this.finish = finish;
		this.flush();
	}
	private flush(): void {
		if (this.delivered || !this.finish || this.waiters > 0) return;
		this.delivered = true;
		this.finish(this.consumed || !this.notifyCompletion ? "tool" : "notice");
	}
}
