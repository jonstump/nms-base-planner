//go:build js && wasm

// Command planner is the WASM entry point: the only place in the tree that
// touches syscall/js.
//
// Governing: ADR-0003 (Go domain, thin adapter), SPEC-0002 REQ "Boundary
// Surface", REQ "Module Lifecycle and Readiness", REQ "Event Loop Safety"
//
// It does one thing: hand strings between JavaScript and bridge.Module. Every
// decision about what the entry points are, when they are callable, and what
// comes back lives in internal/bridge, which builds and tests without WASM.
// This file is deliberately too small to hide a bug in.
package main

import (
	"syscall/js"

	"github.com/jonstump/nms-base-planner/internal/bridge"
)

func main() {
	module := bridge.NewModule()

	// One namespace object carrying the stage entry points. No domain
	// function is reachable from the global scope: the only exported names
	// are these, and each returns a complete envelope.
	//
	// Governing: SPEC-0002 REQ "Boundary Surface".
	namespace := js.Global().Get("Object").New()
	for _, name := range bridge.EntryPoints {
		namespace.Set(name, entryPoint(module, name))
	}
	namespace.Set("contractVersion", bridge.ContractVersion)
	js.Global().Set(bridge.Namespace, namespace)

	// Park forever. Returning from main tears the Go runtime down and every
	// registered function with it.
	//
	// This is the only blocking construct in the module, and it is outside
	// every entry point: the calls themselves are synchronous and
	// straight-line, so nothing can deadlock against the event loop by
	// waiting on it from inside a call.
	// Governing: SPEC-0002 REQ "Event Loop Safety".
	select {}
}

// entryPoint wraps one named call.
//
// Synchronous and straight-line by construction: it reads one string
// argument, dispatches, and returns one string. No goroutine, no channel, no
// callback into JavaScript — so a call can neither block the event loop
// waiting for JavaScript nor deadlock against the Go scheduler.
func entryPoint(module *bridge.Module, name string) js.Func {
	return js.FuncOf(func(_ js.Value, args []js.Value) any {
		var arg string
		if len(args) > 0 && args[0].Type() == js.TypeString {
			arg = args[0].String()
		}
		return module.CallJSON(name, arg)
	})
}
