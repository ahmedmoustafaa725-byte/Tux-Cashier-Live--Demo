import { render, screen } from '@testing-library/react';
jest.mock("jspdf", () => {
  return jest.fn().mockImplementation(() => ({
    addImage: jest.fn(),
    addFileToVFS: jest.fn(),
    addFont: jest.fn(),
    setFont: jest.fn(),
    setFontSize: jest.fn(),
    text: jest.fn(),
    save: jest.fn(),
  }));
});
jest.mock("jspdf-autotable", () => jest.fn());

const App = require("./App").default;

test("renders POS header", () => {
  render(<App />);
    expect(screen.getByText(/burger truck pos/i)).toBeInTheDocument();

});
