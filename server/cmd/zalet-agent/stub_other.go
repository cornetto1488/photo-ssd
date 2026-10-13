//go:build !windows && !linux

// Агент ZALET работает в Windows и Linux; на других системах — заглушка, чтобы собирался весь проект.
package main

import "fmt"

func main() { fmt.Println("ZALET Agent работает только в Windows") }
