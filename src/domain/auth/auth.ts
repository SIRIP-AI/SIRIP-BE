export type AuthUser = {
  id: string;
  name: string;
  email: string;
  phone: string;
};

export type LoginCredentials = {
  email: string;
  password: string;
};

export type RegistrationInput = LoginCredentials & {
  name: string;
  phone: string;
};
