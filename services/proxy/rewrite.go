package main

import (
	"bytes"
	"fmt"
	"net/url"
	"regexp"
	"strings"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

var cssURLPattern = regexp.MustCompile(`url\(\s*(?:"([^"]+)"|'([^']+)'|([^)]+))\s*\)`)

// rewriteCSSURLs rewrites CSS url(...) references so stylesheets keep loading assets through the proxy.
func rewriteCSSURLs(css string, base *url.URL) string {
	return cssURLPattern.ReplaceAllStringFunc(css, func(match string) string {
		sub := cssURLPattern.FindStringSubmatch(match)
		var raw string
		for i := 1; i < len(sub); i++ {
			if sub[i] != "" {
				raw = sub[i]
				break
			}
		}
		raw = strings.TrimSpace(raw)
		if proxied, ok := rewriteProxyAttr(raw, base); ok {
			return fmt.Sprintf(`url("%s")`, proxied)
		}
		return match
	})
}

// rewriteSrcset rewrites each image candidate URL while preserving width and density descriptors.
func rewriteSrcset(value string, base *url.URL) string {
	parts := strings.Split(value, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		trimmed := strings.TrimSpace(p)
		if trimmed == "" {
			out = append(out, "")
			continue
		}
		fields := strings.Fields(trimmed)
		urlPart := fields[0]
		descriptor := strings.Join(fields[1:], " ")
		rewritten, ok := rewriteProxyAttr(urlPart, base)
		if !ok {
			rewritten = urlPart
		}
		if descriptor != "" {
			out = append(out, rewritten+" "+descriptor)
		} else {
			out = append(out, rewritten)
		}
	}
	return strings.Join(out, ", ")
}

// getAttr returns an HTML attribute value from a parsed node. The key match
// is case-insensitive so callers don't have to lower-case ahead of time and
// uppercased markup (e.g. <META PROPERTY="…">) still resolves.
func getAttr(n *html.Node, key string) (string, bool) {
	for _, a := range n.Attr {
		if strings.EqualFold(a.Key, key) {
			return a.Val, true
		}
	}
	return "", false
}

// setAttr updates or appends an HTML attribute on a parsed node.
func setAttr(n *html.Node, key, val string) {
	for i, a := range n.Attr {
		if a.Key == key {
			n.Attr[i].Val = val
			return
		}
	}
	n.Attr = append(n.Attr, html.Attribute{Key: key, Val: val})
}

// removeAttr deletes an HTML attribute from a parsed node when present.
func removeAttr(n *html.Node, key string) {
	for i, a := range n.Attr {
		if a.Key == key {
			n.Attr = append(n.Attr[:i], n.Attr[i+1:]...)
			return
		}
	}
}

// rewriteAttrIfPresent proxies a node attribute if the attribute exists and points to a network URL.
func rewriteAttrIfPresent(n *html.Node, key string, base *url.URL) {
	v, ok := getAttr(n, key)
	if !ok {
		return
	}
	if proxied, ok := rewriteProxyAttr(v, base); ok {
		setAttr(n, key, proxied)
	}
}

// findFirst returns the first element node with the requested tag below n.
func findFirst(n *html.Node, tag string) *html.Node {
	if n.Type == html.ElementNode && n.Data == tag {
		return n
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if found := findFirst(c, tag); found != nil {
			return found
		}
	}
	return nil
}

// rewriteHTMLDocument injects the selection runtime and rewrites document links/assets through the proxy.
func rewriteHTMLDocument(doc string, target *url.URL, record bool) (string, error) {
	root, err := html.Parse(strings.NewReader(doc))
	if err != nil {
		return "", err
	}

	var walk func(n *html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode {
			switch n.Data {
			case "meta":
				if v, ok := getAttr(n, "http-equiv"); ok {
					low := strings.ToLower(v)
					if low == "content-security-policy" || low == "x-frame-options" {
						if n.Parent != nil {
							n.Parent.RemoveChild(n)
						}
						return
					}
				}
			case "base", "a":
				rewriteAttrIfPresent(n, "href", target)
			case "link":
				removeAttr(n, "integrity")
				removeAttr(n, "crossorigin")
				rewriteAttrIfPresent(n, "href", target)
			case "form":
				rewriteAttrIfPresent(n, "action", target)
			case "img", "source":
				if v, ok := getAttr(n, "srcset"); ok {
					setAttr(n, "srcset", rewriteSrcset(v, target))
				}
			}
			if _, ok := getAttr(n, "src"); ok {
				removeAttr(n, "integrity")
				removeAttr(n, "crossorigin")
				rewriteAttrIfPresent(n, "src", target)
			}
			if _, ok := getAttr(n, "poster"); ok {
				rewriteAttrIfPresent(n, "poster", target)
			}
		}
		for c := n.FirstChild; c != nil; {
			next := c.NextSibling
			walk(c)
			c = next
		}
	}
	walk(root)

	if head := findFirst(root, "head"); head != nil {
		ctx := &html.Node{Type: html.ElementNode, DataAtom: atom.Head, Data: "head"}
		frags, err := html.ParseFragment(strings.NewReader(previewRuntime(target, record)), ctx)
		if err != nil {
			return "", err
		}
		for i := len(frags) - 1; i >= 0; i-- {
			frag := frags[i]
			if head.FirstChild != nil {
				head.InsertBefore(frag, head.FirstChild)
			} else {
				head.AppendChild(frag)
			}
		}
	}

	var buf bytes.Buffer
	if err := html.Render(&buf, root); err != nil {
		return "", err
	}
	return buf.String(), nil
}
