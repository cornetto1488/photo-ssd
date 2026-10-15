//go:build !windows && !linux

package main

import (
	"errors"
	"os/exec"
)

func command(name string, args ...string) *exec.Cmd { return exec.Command(name, args...) }
func tailscalePaths() []string                      { return nil }
func openBrowser(u string)                          { exec.Command("open", u).Start() }
func platformComponents(c Config) []Comp            { return nil }
func runAction(id string, c Config) error           { return errors.New("эта система пока не поддерживается") }
func undoAction(id string, c Config) error          { return errors.New("эта система пока не поддерживается") }
func installTailscale() error                       { openBrowser("https://tailscale.com/download"); return nil }
