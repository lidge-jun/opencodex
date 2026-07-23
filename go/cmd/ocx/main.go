package main

import "fmt"

// Version is replaced by the release build in a later work package.
const Version = "0.1.0-dev"

func main() {
	fmt.Printf("ocx %s\n", Version)
}
