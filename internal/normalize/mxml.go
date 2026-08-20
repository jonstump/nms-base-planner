package normalize

import (
	"encoding/xml"
	"fmt"
	"io"
	"os"
	"strconv"
)

// Governing: ADR-0001 (two-tier NMS data ingestion), SPEC-0004 REQ
// "Structural Surprise Fails Loudly"
//
// MBINCompiler emits .MXML: a uniform tree of <Property> elements carrying
// name/value/_id/_index attributes, where nesting rather than element naming
// conveys structure.
//
//	<Data template="cGcProductTable">
//	  <Property name="Table">
//	    <Property name="Table" value="GcProductData" _id="CASING">
//	      <Property name="ID" value="CASING" />
//
// Every accessor here is fail-closed. A field that is absent, or present
// with an unparseable value, returns an error naming the table and the row
// rather than a zero value — because a zero value for a recipe quantity or
// an item ID produces an artifact that loads cleanly and is wrong.

// node is one <Property> element.
type node struct {
	Name  string `xml:"name,attr"`
	Value string `xml:"value,attr"`
	ID    string `xml:"_id,attr"`
	Index string `xml:"_index,attr"`
	Props []node `xml:"Property"`
}

// mxmlDoc is a decompiled .MXML file.
type mxmlDoc struct {
	Template string `xml:"template,attr"`
	Props    []node `xml:"Property"`
}

// readMXML parses a .MXML file and checks its template.
//
// wantTemplate guards against pointing the wrong parser at the right-looking
// file — a mistake that would otherwise surface as an empty table rather
// than an error.
func readMXML(path, wantTemplate string) (*mxmlDoc, error) {
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, Missing(path)
		}
		return nil, fmt.Errorf("opening %s: %w", path, err)
	}
	defer f.Close()
	return decodeMXML(f, path, wantTemplate)
}

// decodeMXML parses from a reader, so tests need not touch the filesystem.
func decodeMXML(r io.Reader, name, wantTemplate string) (*mxmlDoc, error) {
	var doc mxmlDoc
	if err := xml.NewDecoder(r).Decode(&doc); err != nil {
		return nil, fmt.Errorf("%w: parsing %s: %v", ErrStructureUnrecognized, name, err)
	}
	if wantTemplate != "" && doc.Template != wantTemplate {
		return nil, Unrecognized(name, "", "template", wantTemplate, doc.Template)
	}
	return &doc, nil
}

// child returns the first direct child with the given name.
func (n node) child(name string) (node, bool) {
	for _, p := range n.Props {
		if p.Name == name {
			return p, true
		}
	}
	return node{}, false
}

// children returns every direct child with the given name.
func (n node) children(name string) []node {
	var out []node
	for _, p := range n.Props {
		if p.Name == name {
			out = append(out, p)
		}
	}
	return out
}

// str returns a required string field.
func (n node) str(table, row, field string) (string, error) {
	c, ok := n.child(field)
	if !ok {
		return "", Unrecognized(table, row, field, "present", "absent")
	}
	return c.Value, nil
}

// nonEmpty returns a required string field that must not be blank.
func (n node) nonEmpty(table, row, field string) (string, error) {
	v, err := n.str(table, row, field)
	if err != nil {
		return "", err
	}
	if v == "" {
		return "", Unrecognized(table, row, field, "a non-empty value", `""`)
	}
	return v, nil
}

// int64 returns a required integer field.
func (n node) int64(table, row, field string) (int64, error) {
	c, ok := n.child(field)
	if !ok {
		return 0, Unrecognized(table, row, field, "present", "absent")
	}
	v, err := parseInt(c.Value)
	if err != nil {
		return 0, Unrecognized(table, row, field, "an integer", c.Value)
	}
	return v, nil
}

// boolean returns a required boolean field.
func (n node) boolean(table, row, field string) (bool, error) {
	c, ok := n.child(field)
	if !ok {
		return false, Unrecognized(table, row, field, "present", "absent")
	}
	switch c.Value {
	case "true":
		return true, nil
	case "false":
		return false, nil
	default:
		return false, Unrecognized(table, row, field, "true or false", c.Value)
	}
}

// float returns a required float field. MBINCompiler emits every float as a
// fixed-point decimal ("150.000000"), so this is exact for the values it is
// used on — class strengths and weightings — and would only lose precision
// on a value the source does not contain.
func (n node) float(table, row, field string) (float64, error) {
	c, ok := n.child(field)
	if !ok {
		return 0, Unrecognized(table, row, field, "present", "absent")
	}
	v, err := strconv.ParseFloat(c.Value, 64)
	if err != nil {
		return 0, Unrecognized(table, row, field, "a number", c.Value)
	}
	return v, nil
}

// rows returns the table's row elements.
//
// The outer <Property name="Table"> wraps a repeated inner
// <Property name="Table" value="GcXxx">; this walks both so callers work in
// rows rather than in tree shape.
func (d *mxmlDoc) rows(table, wrapper, rowValue string) ([]node, error) {
	var outer node
	var found bool
	for _, p := range d.Props {
		if p.Name == wrapper {
			outer, found = p, true
			break
		}
	}
	if !found {
		return nil, Unrecognized(table, "", wrapper, "present", "absent")
	}
	rows := outer.children(wrapper)
	if len(rows) == 0 {
		return nil, Unrecognized(table, "", wrapper, "at least one row", "none")
	}
	for i, r := range rows {
		if r.Value != rowValue {
			return nil, Unrecognized(table, fmt.Sprintf("row %d", i), "value", rowValue, r.Value)
		}
	}
	return rows, nil
}

// parseInt accepts the integer and float-formatted integers MBINCompiler
// emits ("1", "250", "5.000000") and refuses anything with a fractional
// part, since every field this is used for is a count.
func parseInt(s string) (int64, error) {
	if s == "" {
		return 0, fmt.Errorf("empty")
	}
	neg := false
	i := 0
	if s[0] == '-' || s[0] == '+' {
		neg = s[0] == '-'
		i = 1
	}
	var v int64
	digits := 0
	for ; i < len(s); i++ {
		c := s[i]
		if c == '.' {
			// A float-formatted integer is fine; a real fraction is not.
			for j := i + 1; j < len(s); j++ {
				if s[j] != '0' {
					return 0, fmt.Errorf("has a fractional part")
				}
			}
			break
		}
		if c < '0' || c > '9' {
			return 0, fmt.Errorf("not a number")
		}
		v = v*10 + int64(c-'0')
		digits++
	}
	if digits == 0 {
		return 0, fmt.Errorf("no digits")
	}
	if neg {
		v = -v
	}
	return v, nil
}
