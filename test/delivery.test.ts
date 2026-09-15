import { test } from "node:test";
import assert from "node:assert/strict";
import { CompletionDelivery } from "../src/delivery.ts";

test("synchronous completion belongs to tool; unattended async completion notifies once", () => {
	for (const notify of [false, true]) {
		const channels: string[] = [];
		const delivery = new CompletionDelivery(notify);
		delivery.complete(channel => channels.push(channel));
		delivery.complete(channel => channels.push(channel));
		assert.deepEqual(channels, [notify ? "notice" : "tool"]);
	}
});

test("active wait consumes completion, including multiple waiters and interrupted waits", () => {
	for (const consumed of [false, true]) {
		const channels: string[] = [];
		const delivery = new CompletionDelivery(true);
		const first = delivery.claim();
		const second = delivery.claim();
		delivery.complete(channel => channels.push(channel));
		assert.deepEqual(channels, []);
		first(false);
		assert.deepEqual(channels, []);
		second(consumed);
		second(false);
		assert.deepEqual(channels, [consumed ? "tool" : "notice"]);
	}
});

test("aborted wait before completion restores asynchronous delivery", () => {
	const channels: string[] = [];
	const delivery = new CompletionDelivery(true);
	delivery.claim()(false);
	delivery.complete(channel => channels.push(channel));
	assert.deepEqual(channels, ["notice"]);
});
